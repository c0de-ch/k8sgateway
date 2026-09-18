import "server-only";
import { rolesFromTokens } from "./roles";
import { getConfig } from "./config";
import { errorSummary, log } from "./log";
import { refresh } from "./oidc";
import { clearSession, getSession, isExpiringSoon, setSession, type Session } from "./session";

/**
 * Builds the cookie payload from a token endpoint response (login or refresh).
 * `expires_in` is the IdP's word on the access-token lifetime; fall back to 5 minutes if absent.
 */
export function sessionFromTokens(
  tokens: { access_token: string; refresh_token?: string; id_token?: string; expiresIn(): number | undefined },
  idClaims: Record<string, unknown> | undefined,
  previous?: Session,
): Session {
  const cfg = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    sub: str(idClaims?.sub) ?? previous?.sub ?? "",
    name: str(idClaims?.name) ?? previous?.name,
    preferredUsername: str(idClaims?.preferred_username) ?? previous?.preferredUsername,
    email: str(idClaims?.email) ?? previous?.email,
    roles: rolesFromTokens(tokens.access_token, idClaims, cfg),
    accessToken: tokens.access_token,
    // Keycloak and the mock IdP rotate refresh tokens; others may return none on refresh -> keep the old one.
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    idToken: tokens.id_token ?? previous?.idToken,
    idTokenDropped: previous?.idTokenDropped,
    issuedAt: now,
    expiresAt: now + (tokens.expiresIn() ?? 300),
    authTime: previous?.authTime ?? now,
  };
}

export type ApiSession = { ok: true; session: Session } | { ok: false; response: Response };

/**
 * IdPs that ROTATE refresh tokens (Keycloak, the mock IdP) invalidate the old one on use. Two browser
 * tabs hitting /api/bff/* at the same moment would otherwise race: the second refresh fails and logs
 * the user out. Requests in the same process therefore share one in-flight refresh per refresh token.
 */
const inflight = new Map<string, Promise<Session>>();

function refreshOnce(session: Session): Promise<Session> {
  const token = session.refreshToken!;
  let pending = inflight.get(token);
  if (!pending) {
    pending = refresh(token)
      .then((tokens) => sessionFromTokens(tokens, tokens.claims(), session))
      .finally(() => inflight.delete(token));
    inflight.set(token, pending);
  }
  return pending;
}

/**
 * For /api/bff/* Route Handlers: returns a session whose access token is valid for at least 30 more
 * seconds, refreshing it (and rewriting the cookie) when needed. Route Handlers are the only place
 * where a refresh may happen, because only they can set cookies.
 */
export async function requireApiSession(): Promise<ApiSession> {
  const session = await getSession();
  if (!session) return { ok: false, response: unauthorized("unauthenticated", "no session cookie — log in first") };
  if (!isExpiringSoon(session)) return { ok: true, session };
  if (!session.refreshToken) {
    await clearSession();
    return { ok: false, response: unauthorized("session_expired", "access token expired and no refresh token available") };
  }
  try {
    const fresh = await setSession(await refreshOnce(session));
    log.info("token refreshed", { sub: fresh.sub, expiresAt: fresh.expiresAt });
    return { ok: true, session: fresh };
  } catch (err) {
    // invalid_grant (refresh token revoked/expired at the IdP) or the IdP is down: end the session cleanly.
    log.warn("token refresh failed", errorSummary(err));
    await clearSession();
    return { ok: false, response: unauthorized("session_expired", "token refresh failed — log in again") };
  }
}

function unauthorized(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 401 });
}
