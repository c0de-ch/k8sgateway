/**
 * Stateless, encrypted cookie payloads: JWE compact serialisation with alg "dir" + enc "A256GCM".
 * "dir" means the 32-byte SESSION_SECRET *is* the content-encryption key — no key wrapping, tiny header.
 * AES-GCM gives confidentiality AND integrity, so a tampered or forged cookie simply fails to decrypt.
 * This file has no Next.js imports so it can be unit-tested with node --test.
 */
import { EncryptJWT, jwtDecrypt, type JWTPayload } from "jose";

/** Issuer/audience baked into every sealed payload so a cookie from another app never decrypts here. */
const SEAL_ISSUER = "k8sgateway-nextjs";

export const SESSION_COOKIE = "k8sgw_session";
/** Overflow cookie for the ID token when the session would exceed the ~4 KB per-cookie browser limit. */
export const ID_TOKEN_COOKIE = "k8sgw_session_idt";
/** Short-lived login transaction: PKCE verifier, state, nonce and returnTo during the IdP round trip. */
export const TXN_COOKIE = "k8sgw_txn";

export interface Session {
  sub: string;
  name?: string;
  preferredUsername?: string;
  email?: string;
  /** Application roles derived from the access token via ROLES_CLAIM / ROLE_USER / ROLE_ADMIN. */
  roles: ("user" | "admin")[];
  /** Tokens stay inside this encrypted, httpOnly cookie — the browser never sees them in clear text. */
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Set when the ID token had to be dropped: even its own overflow cookie would exceed the browser limit. */
  idTokenDropped?: boolean;
  /** When the current access token was obtained (login or refresh), epoch seconds. */
  issuedAt: number;
  /** Access-token expiry, epoch seconds. */
  expiresAt: number;
  /** When the login happened, epoch seconds. */
  authTime: number;
}

export interface LoginTransaction {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

/** SESSION_SECRET is 64 hex characters (openssl rand -hex 32) -> exactly the 32 bytes A256GCM needs. */
export function keyFromHex(secret: string | undefined): Uint8Array {
  if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error("SESSION_SECRET must be 64 hex characters (32 bytes), e.g. from `openssl rand -hex 32`");
  }
  return new Uint8Array(Buffer.from(secret, "hex"));
}

/** Encrypts `payload` into a compact JWE that expires after `ttlSeconds`. */
export function seal(payload: object, ttlSeconds: number, key: Uint8Array): Promise<string> {
  return new EncryptJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setIssuer(SEAL_ISSUER)
    .setAudience(SEAL_ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .encrypt(key);
}

/** Decrypts and validates a sealed payload; ANY failure (expired, tampered, wrong key) yields null. */
export async function unseal<T extends object>(token: string | undefined, key: Uint8Array): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, key, {
      issuer: SEAL_ISSUER,
      audience: SEAL_ISSUER,
      keyManagementAlgorithms: ["dir"], // pin the algorithms: never let the header pick them
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return payload as unknown as T;
  } catch {
    return null;
  }
}

/**
 * Access token expired or about to expire. The 30 s guard keeps relayed calls from failing mid-flight;
 * it is capped at half the token lifetime so very short-lived demo tokens (MOCK_ACCESS_TOKEN_TTL=30)
 * are not "expiring" the moment they arrive — that would send pages into an endless refresh loop.
 */
export function isExpiringSoon(
  session: Pick<Session, "issuedAt" | "expiresAt">,
  guardSeconds = 30,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const lifetime = session.expiresAt - session.issuedAt;
  const guard = Number.isFinite(lifetime) ? Math.min(guardSeconds, Math.floor(lifetime / 2)) : guardSeconds;
  return session.expiresAt - guard <= now;
}

/** Sanity check for a returnTo path: relative, absolute-path-only, so nobody can bounce users to another site. */
export function safeReturnTo(value: string | null | undefined, fallback = "/"): string {
  if (!value) return fallback;
  return /^\/(?![/\\])/.test(value) ? value : fallback;
}
