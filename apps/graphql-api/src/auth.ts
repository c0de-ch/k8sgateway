/**
 * Access-token verification with jose.
 *
 * Rules (the same as the REST API):
 *   - signature via the IdP's JWKS (asymmetric algorithms only; `alg=none` and HS* are rejected)
 *   - `iss`  must equal OIDC_ISSUER_CLAIM (defaults to OIDC_ISSUER) byte-for-byte
 *   - `aud`  (string or array) must contain OIDC_AUDIENCE
 *   - `exp`  is mandatory (RFC 9068 §2.2) — a token that never expires is invalid; `exp`/`nbf` get 60 s clock tolerance
 *   - `sub`  is mandatory and non-empty
 *   - roles are read from the dotted path ROLES_CLAIM (array or space-separated string)
 *
 * The JWKS URL comes from OIDC discovery (or the OIDC_JWKS_URI override). Discovery is lazy and
 * retried in the background so the process never crashes when the IdP is not reachable yet.
 */
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload, type RemoteJWKSet } from 'jose';
import type { Config } from './config.js';
import { silentLogger, type Logger } from './log.js';

/** Allow-list of signature algorithms. Symmetric algorithms would let anyone with the JWKS mint tokens. */
export const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'] as const;
const CLOCK_TOLERANCE_SECONDS = 60;

export interface AuthUser {
  sub: string;
  name?: string;
  preferredUsername?: string;
  email?: string;
  /** Raw values found at ROLES_CLAIM (compared against ROLE_USER / ROLE_ADMIN). */
  roles: string[];
  claims: JWTPayload;
  /** The raw bearer token — needed to relay it to the REST API. Never log it. */
  token: string;
}

export type AuthErrorKind = 'invalid_token' | 'idp_unavailable';

export class AuthError extends Error {
  constructor(
    readonly kind: AuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface DiscoveryState {
  ready: boolean;
  source: 'env' | 'discovery';
  /** The `iss` value tokens must carry (OIDC_ISSUER_CLAIM, or the form advertised by discovery — see discoverJwksUri). */
  issuer: string;
  jwksUri?: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export type VerifierConfig = Pick<Config, 'issuer' | 'issuerClaim' | 'issuerClaimExplicit' | 'jwksUri' | 'audience' | 'rolesClaim' | 'discoveryRetryMs'>;

export interface Verifier {
  /** Verifies a raw JWT. Throws AuthError('invalid_token' | 'idp_unavailable'). */
  verify(token: string): Promise<AuthUser>;
  /**
   * Turns an Authorization header into a context user.
   * No header -> anonymous. Bad token -> anonymous + reason (app.ts turns that into a 401 for the whole request).
   * Throws AuthError('idp_unavailable') when the keys cannot be loaded at all.
   */
  authenticate(authorization: string | undefined): Promise<{ user: AuthUser | null; error?: string }>;
  /** Resolves the JWKS resolver, running discovery (once) if necessary. */
  ensureKeys(): Promise<RemoteJWKSet>;
  /** Starts the background discovery retry loop. */
  start(): void;
  stop(): void;
  state(): DiscoveryState;
}

/** Reads a dotted path such as `realm_access.roles` from the claims. */
export function getClaimPath(claims: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined), claims);
}

/** Roles may be a JSON array (Keycloak, Entra roles) or a space-separated string (scope/scp). Missing => []. */
export function extractRoles(claims: JWTPayload, rolesClaim: string): string[] {
  const raw = getClaimPath(claims, rolesClaim);
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function toAuthUser(claims: JWTPayload, token: string, rolesClaim: string): AuthUser {
  return {
    sub: claims.sub as string,
    // Oracle IAM uses user_displayname; Entra v1 tokens use upn instead of preferred_username.
    name: optionalString(claims['name']) ?? optionalString(claims['user_displayname']),
    preferredUsername: optionalString(claims['preferred_username']) ?? optionalString(claims['upn']),
    email: optionalString(claims['email']),
    roles: extractRoles(claims, rolesClaim),
    claims,
    token,
  };
}

interface DiscoveryDocument {
  issuer?: unknown;
  jwks_uri?: unknown;
}

const stripSlash = (s: string): string => s.replace(/\/+$/, '');

export function createVerifier(cfg: VerifierConfig, deps: { logger?: Logger; fetchImpl?: typeof fetch } = {}): Verifier {
  const logger = deps.logger ?? silentLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const discoveryUrl = `${stripSlash(cfg.issuer)}/.well-known/openid-configuration`;

  // The exact `iss` we accept. Changed at most once, by discoverJwksUri(), and only for a trailing slash.
  let expectedIssuer = cfg.issuerClaim;
  const state: DiscoveryState = { ready: false, source: cfg.jwksUri ? 'env' : 'discovery', issuer: expectedIssuer, attempts: 0 };
  let keys: RemoteJWKSet | undefined;
  let inflight: Promise<RemoteJWKSet> | undefined;
  let stopped = false;
  let loopRunning = false;
  let wake: (() => void) | undefined;

  async function discoverJwksUri(): Promise<string> {
    const res = await fetchImpl(discoveryUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`discovery ${discoveryUrl} answered HTTP ${res.status}`);
    const doc = (await res.json()) as DiscoveryDocument;
    if (typeof doc.jwks_uri !== 'string') throw new Error('discovery document has no jwks_uri');
    // OIDC Discovery §4.3: the advertised issuer must be the one we will trust in tokens.
    // Oracle IAM advertises a different issuer than its discovery URL -> OIDC_ISSUER_CLAIM makes that explicit.
    if (doc.issuer !== expectedIssuer) {
      const advertised = typeof doc.issuer === 'string' ? doc.issuer : '';
      const slashOnly = advertised !== '' && stripSlash(advertised) === stripSlash(expectedIssuer);
      if (!slashOnly || cfg.issuerClaimExplicit) {
        throw new Error(`discovery issuer "${String(doc.issuer)}" != expected "${expectedIssuer}" (set OIDC_ISSUER_CLAIM if this is intended)`);
      }
      // Same issuer, only the trailing slash differs (typically OIDC_ISSUER pasted with a "/"): tokens carry the advertised form.
      logger.warn('adopting the issuer advertised by discovery (differs from OIDC_ISSUER only by a trailing slash)', { configured: expectedIssuer, advertised });
      expectedIssuer = advertised;
      state.issuer = advertised;
    }
    return doc.jwks_uri;
  }

  async function loadKeys(): Promise<RemoteJWKSet> {
    state.attempts++;
    state.lastAttemptAt = new Date().toISOString();
    try {
      const jwksUri = cfg.jwksUri ?? (await discoverJwksUri());
      const set = createRemoteJWKSet(new URL(jwksUri), {
        cooldownDuration: 30_000, // an unknown `kid` refetches at most every 30s (protects the IdP)
        cacheMaxAge: 600_000, // keys are refreshed at least every 10 minutes
        timeoutDuration: 5_000,
      });
      await set.reload(); // fetch once now: "ready" means the keys are really loaded
      keys = set;
      state.ready = true;
      state.jwksUri = jwksUri;
      delete state.lastError;
      logger.info('oidc keys loaded', { jwksUri, issuer: expectedIssuer, audience: cfg.audience, attempts: state.attempts });
      return set;
    } catch (e) {
      state.lastError = (e as Error).message;
      logger.warn('oidc key loading failed', { attempt: state.attempts, error: state.lastError });
      throw e;
    }
  }

  function ensureKeys(): Promise<RemoteJWKSet> {
    if (keys) return Promise.resolve(keys);
    if (!inflight) {
      const p = loadKeys();
      inflight = p;
      p.catch(() => undefined).finally(() => {
        if (inflight === p) inflight = undefined;
      });
    }
    return inflight;
  }

  function start(): void {
    if (loopRunning) return;
    loopRunning = true;
    stopped = false;
    void (async () => {
      let delay = cfg.discoveryRetryMs;
      while (!stopped && !keys) {
        try {
          await ensureKeys();
        } catch {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, delay).unref();
          });
          delay = Math.min(delay * 2, 30_000); // exponential back-off, capped
        }
      }
      loopRunning = false;
    })();
  }

  function stop(): void {
    stopped = true;
    wake?.();
  }

  async function verify(token: string): Promise<AuthUser> {
    let getKey: RemoteJWKSet;
    try {
      getKey = await ensureKeys();
    } catch (e) {
      throw new AuthError('idp_unavailable', `cannot load signing keys: ${(e as Error).message}`);
    }
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: expectedIssuer, // exact match against `iss`
        audience: cfg.audience, // `aud` (string or array) must contain it
        algorithms: [...ALLOWED_ALGS], // checked before any key lookup
        requiredClaims: ['exp', 'sub'], // jose validates `exp` only when present -> without this a never-expiring token would pass
        clockTolerance: CLOCK_TOLERANCE_SECONDS, // applies to `exp` and `nbf` (`iat` is only checked together with maxTokenAge)
      });
      // requiredClaims is a presence check; an empty string would still slip through.
      if (typeof payload.sub !== 'string' || payload.sub === '') throw new AuthError('invalid_token', 'token has no sub claim');
      return toAuthUser(payload, token, cfg.rolesClaim);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      if (e instanceof joseErrors.JWKSTimeout) throw new AuthError('idp_unavailable', 'timeout while fetching JWKS');
      if (e instanceof joseErrors.JWTExpired) throw new AuthError('invalid_token', 'token expired');
      if (e instanceof joseErrors.JWKSNoMatchingKey) throw new AuthError('invalid_token', 'no matching signing key (kid)');
      if (e instanceof joseErrors.JOSEError) throw new AuthError('invalid_token', e.message); // jose messages never contain our config
      // e.g. a network error while jose refreshes the JWKS for an unknown kid
      throw new AuthError('idp_unavailable', `key lookup failed: ${(e as Error).message}`);
    }
  }

  async function authenticate(authorization: string | undefined): Promise<{ user: AuthUser | null; error?: string }> {
    if (!authorization || authorization.trim() === '') return { user: null };
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (!match) return { user: null, error: 'Authorization header must be "Bearer <token>"' };
    try {
      return { user: await verify(match[1] as string) };
    } catch (e) {
      if (e instanceof AuthError && e.kind === 'invalid_token') return { user: null, error: e.message };
      throw e;
    }
  }

  return { verify, authenticate, ensureKeys, start, stop, state: () => ({ ...state }) };
}
