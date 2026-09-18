import "server-only";
import * as client from "openid-client";
import { getConfig, type AppConfig } from "./config";
import { log } from "./log";

/**
 * openid-client Configuration, built once per process and cached (discovery is one HTTP call).
 * On failure the cache is cleared so the next request retries — the pod must not need a restart
 * just because the IdP was slow to come up.
 */
let cached: Promise<client.Configuration> | undefined;

export function getOidcConfig(): Promise<client.Configuration> {
  cached ??= buildConfiguration().catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
}

/** Maps OIDC_CLIENT_AUTH to the token-endpoint authentication method. */
function clientAuth(cfg: AppConfig): client.ClientAuth {
  switch (cfg.oidcClientAuth) {
    case "none":
      return client.None(); // public client: PKCE only, no secret
    case "client_secret_basic":
      return client.ClientSecretBasic(cfg.oidcClientSecret); // Oracle IAM lists only *_basic / *_jwt
    default:
      return client.ClientSecretPost(cfg.oidcClientSecret); // Keycloak / Entra / mock default
  }
}

async function buildConfiguration(): Promise<client.Configuration> {
  const cfg = getConfig();
  const plainHttp = cfg.oidcIssuer.startsWith("http://");
  if (plainHttp && cfg.oidcRequireHttps) {
    throw new Error(`OIDC_ISSUER ${cfg.oidcIssuer} is plain http but OIDC_REQUIRE_HTTPS=true`);
  }
  // allowInsecureRequests is for local kind clusters only (mock IdP / Keycloak over http). It is gated
  // on the issuer scheme so the very same image refuses http with a real, https IdP.
  // enableNonRepudiationChecks makes openid-client fetch jwks_uri and verify the ID token's JWS signature.
  // Without it the library trusts the token endpoint's channel (fine over TLS, not over plain http).
  const execute = [...(plainHttp ? [client.allowInsecureRequests] : []), client.enableNonRepudiationChecks];
  const metadata: Partial<client.ClientMetadata> = { client_secret: cfg.oidcClientSecret };
  const options: client.DiscoveryRequestOptions = { execute, timeout: 10 };
  const manual = cfg.oidcIssuerClaim !== cfg.oidcIssuer;

  let config: client.Configuration;
  if (!manual) {
    // Normal case: fetch <issuer>/.well-known/openid-configuration and REQUIRE metadata.issuer === issuer.
    // (Entra's tenant issuer https://login.microsoftonline.com/<tenant>/v2.0 passes this check as well.)
    config = await client.discovery(new URL(cfg.oidcIssuer), cfg.oidcClientId, metadata, clientAuth(cfg), options);
    if (cfg.oidcJwksUri) {
      // OIDC_JWKS_URI (shared contract): rebuild with the override; everything else stays as discovered.
      config = new client.Configuration(normaliseServerMetadata(config.serverMetadata(), cfg), cfg.oidcClientId, metadata, clientAuth(cfg));
      for (const fn of execute) fn(config);
    }
  } else {
    // Oracle IAM Identity Domains: the document lives under https://idcs-<guid>.identity.oraclecloud.com but says
    // issuer "https://identity.oraclecloud.com/", so client.discovery() would (rightly) throw an issuer mismatch.
    // Fetch the document ourselves, assert OUR expected issuer, then build the Configuration manually.
    const url = `${cfg.oidcIssuer}/.well-known/openid-configuration`;
    const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OIDC discovery ${url} failed with HTTP ${res.status}`);
    const server = normaliseServerMetadata((await res.json()) as client.ServerMetadata, cfg);
    if (server.issuer !== cfg.oidcIssuerClaim) {
      throw new Error(`discovery issuer "${server.issuer}" does not match OIDC_ISSUER_CLAIM "${cfg.oidcIssuerClaim}"`);
    }
    config = new client.Configuration(server, cfg.oidcClientId, metadata, clientAuth(cfg));
    for (const fn of execute) fn(config);
  }
  const { issuer, jwks_uri } = config.serverMetadata();
  log.info("oidc configuration ok", { issuer, jwksUri: jwks_uri, auth: cfg.oidcClientAuth, discovery: manual ? "manual" : "openid-client" });
  return config;
}

/**
 * Oracle's documented discovery example lists endpoints as relative paths ("/oauth2/v1/authorize"); real tenants
 * usually return absolute URLs. Resolve relative ones against OIDC_ISSUER and apply the OIDC_JWKS_URI override.
 */
function normaliseServerMetadata(server: client.ServerMetadata, cfg: AppConfig): client.ServerMetadata {
  const out: Record<string, unknown> = { ...server };
  for (const [key, value] of Object.entries(out)) {
    if ((key.endsWith("_endpoint") || key === "jwks_uri") && typeof value === "string" && value.startsWith("/")) {
      out[key] = new URL(value, `${cfg.oidcIssuer}/`).href;
    }
  }
  if (cfg.oidcJwksUri) out.jwks_uri = cfg.oidcJwksUri;
  return out as client.ServerMetadata;
}

export const redirectUri = (cfg: AppConfig) => new URL("/api/auth/callback", cfg.publicUrl).href;

/** Authorization request: code flow with PKCE (S256) + state (CSRF) + nonce (ID-token replay protection). */
export interface LoginStart {
  url: URL;
  codeVerifier: string;
  state: string;
  nonce: string;
}

export async function buildLoginUrl(cfg: AppConfig): Promise<LoginStart> {
  const config = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(cfg), // must equal the URI registered at the IdP byte for byte
    scope: cfg.oidcScope,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url, codeVerifier, state, nonce };
}

/**
 * Exchanges the authorization code. openid-client checks state, sends the PKCE verifier to the token endpoint
 * and validates the ID token: iss, aud (= client_id), exp/iat, nonce and — thanks to enableNonRepudiationChecks —
 * its JWS signature against the IdP's JWKS (RS256 family; HS* is rejected).
 * `search` is the query string the IdP redirected back with; the URL is rebuilt from PUBLIC_URL because
 * request.url behind the gateway may show the pod's host and the token endpoint compares redirect_uri.
 */
export async function handleCallback(cfg: AppConfig, search: string, txn: { codeVerifier: string; state: string; nonce: string }) {
  const config = await getOidcConfig();
  const currentUrl = new URL(`/api/auth/callback${search}`, cfg.publicUrl);
  return client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: txn.codeVerifier,
    expectedState: txn.state, // we sent state, so it MUST come back unchanged
    expectedNonce: txn.nonce, // we sent nonce, so the ID token MUST carry it
    idTokenExpected: true,
  });
}

export async function refresh(refreshToken: string) {
  const config = await getOidcConfig();
  return client.refreshTokenGrant(config, refreshToken);
}

/** RP-initiated logout URL, or null when the IdP has no end_session_endpoint. */
export async function endSessionUrl(cfg: AppConfig, idToken: string | undefined): Promise<URL | null> {
  const config = await getOidcConfig();
  if (!config.serverMetadata().end_session_endpoint) return null;
  return client.buildEndSessionUrl(config, {
    post_logout_redirect_uri: `${cfg.publicUrl}/`,
    ...(idToken ? { id_token_hint: idToken } : {}), // lets the IdP skip its "really log out?" page
  });
}

export interface AuthFailure {
  error: string;
  description: string;
}

/** URL of the friendly /auth/error page for a failed login/callback (no stack traces, no internals). */
export function authErrorUrl(publicUrl: string, failure: unknown): URL {
  const { error, description } = isAuthFailure(failure) ? failure : describeOidcError(failure);
  const url = new URL("/auth/error", publicUrl);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  return url;
}

const isAuthFailure = (v: unknown): v is AuthFailure =>
  typeof v === "object" && v !== null && typeof (v as AuthFailure).error === "string" && typeof (v as AuthFailure).description === "string";

/** Turns library/network errors into a short, safe {error, description} pair for the error page. */
export function describeOidcError(err: unknown): AuthFailure {
  if (err instanceof client.AuthorizationResponseError) {
    return { error: err.error, description: err.error_description ?? "the identity provider rejected the authorization request" };
  }
  if (err instanceof client.ResponseBodyError) {
    return { error: err.error, description: err.error_description ?? `token endpoint answered HTTP ${err.status}` };
  }
  if (err instanceof client.ClientError) {
    // the wrapped cause carries the precise reason, e.g. 'unexpected "state" response parameter value'
    const cause = err.cause instanceof Error && err.cause.message !== err.message ? `: ${err.cause.message}` : "";
    return { error: err.code ?? "oidc_client_error", description: `${err.message}${cause}` };
  }
  if (err instanceof Error) {
    const cause = err.cause as { code?: string; message?: string } | undefined;
    const detail = cause?.code ?? cause?.message;
    const network = err.name === "TypeError" || err.name === "TimeoutError" || err.name === "AbortError" || !!cause?.code;
    if (network) return { error: "idp_unreachable", description: `${err.message}${detail ? ` (${detail})` : ""}` };
    return { error: "auth_failed", description: err.message };
  }
  return { error: "auth_failed", description: "unexpected error" };
}
