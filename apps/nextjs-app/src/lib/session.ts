import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getConfig, isHttpsPublicUrl } from "./config";
import { log } from "./log";
import {
  isExpiringSoon,
  keyFromHex,
  seal,
  unseal,
  ID_TOKEN_COOKIE,
  SESSION_COOKIE,
  TXN_COOKIE,
  type LoginTransaction,
  type Session,
} from "./session-crypto";

export { isExpiringSoon, SESSION_COOKIE, TXN_COOKIE, type Session, type LoginTransaction };

/** Absolute lifetime of a login, counted from authTime: refreshing the access token never extends it. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const TXN_TTL_SECONDS = 10 * 60;
/**
 * Browsers cap a cookie at ~4 KB. Keycloak, Entra and Oracle tokens are big: when the session does not
 * fit, the ID token moves to a second cookie (it is only needed again for RP-initiated logout).
 */
const MAX_COOKIE_BYTES = 3500;
const MAX_ID_TOKEN_COOKIE_BYTES = 4000;

interface IdTokenCookie {
  sub: string;
  idToken: string;
}

const sessionKey = () => keyFromHex(getConfig().sessionSecret);

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true, // JavaScript in the browser can never read the tokens
    secure: isHttpsPublicUrl(getConfig()), // Secure cookies are dropped on plain-http hosts
    sameSite: "lax" as const, // "strict" would not send the cookie on the redirect back from the IdP
    path: "/",
    maxAge,
  };
}

/**
 * Read-only session lookup, memoised per request. Safe in Server Components, layouts and Route Handlers.
 * It NEVER refreshes tokens (refresh rewrites the cookie, which only Route Handlers may do).
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const jar = await cookies();
  const key = sessionKey();
  const session = await unseal<Session>(jar.get(SESSION_COOKIE)?.value, key);
  if (!session || session.idToken) return session;
  // Large tokens: the ID token lives in its own cookie (see setSession) - merge it back in.
  const overflow = await unseal<IdTokenCookie>(jar.get(ID_TOKEN_COOKIE)?.value, key);
  return overflow && overflow.sub === session.sub ? { ...session, idToken: overflow.idToken, idTokenDropped: false } : session;
});

/** Route Handlers only: writes the encrypted session cookie(s). */
export async function setSession(session: Session): Promise<Session> {
  const key = sessionKey();
  const jar = await cookies();
  // The cookie and its encrypted payload expire SESSION_TTL_SECONDS after the LOGIN (authTime), not after
  // the last refresh — otherwise a working refresh token would keep the session alive forever.
  const ttl = Math.max(1, session.authTime + SESSION_TTL_SECONDS - Math.floor(Date.now() / 1000));
  let stored: Session = { ...session, idTokenDropped: false };
  let sealed = await seal(stored, ttl, key);
  let overflow: string | null = null;
  if (sealed.length > MAX_COOKIE_BYTES && stored.idToken) {
    // Keycloak/Entra/Oracle ID tokens push the cookie over the browser limit: keep the ID token in a
    // second cookie so logout can still send id_token_hint, or drop it if even that would be too large.
    const idOnly = await seal({ sub: stored.sub, idToken: stored.idToken } satisfies IdTokenCookie, ttl, key);
    if (idOnly.length <= MAX_ID_TOKEN_COOKIE_BYTES) {
      overflow = idOnly;
      log.info("session cookie too large, moving id_token to its own cookie", { bytes: sealed.length, sub: session.sub });
      sealed = await seal({ ...stored, idToken: undefined }, ttl, key);
    } else {
      log.warn("session cookie too large, dropping id_token", { bytes: sealed.length, sub: session.sub });
      stored = { ...stored, idToken: undefined, idTokenDropped: true };
      sealed = await seal(stored, ttl, key);
    }
  }
  jar.set(SESSION_COOKIE, sealed, cookieOptions(ttl));
  if (overflow) jar.set(ID_TOKEN_COOKIE, overflow, cookieOptions(ttl));
  else if (jar.has(ID_TOKEN_COOKIE)) jar.set(ID_TOKEN_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
  return stored;
}

/** Route Handlers only. */
export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
  jar.set(ID_TOKEN_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
}

export async function setLoginTransaction(txn: LoginTransaction): Promise<void> {
  const sealed = await seal(txn, TXN_TTL_SECONDS, sessionKey());
  (await cookies()).set(TXN_COOKIE, sealed, cookieOptions(TXN_TTL_SECONDS));
}

/** Reads AND deletes the transaction cookie: a login transaction is single-use. */
export async function takeLoginTransaction(): Promise<LoginTransaction | null> {
  const jar = await cookies();
  const txn = await unseal<LoginTransaction>(jar.get(TXN_COOKIE)?.value, sessionKey());
  if (jar.has(TXN_COOKIE)) jar.set(TXN_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
  return txn;
}
