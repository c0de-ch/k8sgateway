import "server-only";
import { forbidden, redirect } from "next/navigation";
import { logPage } from "./log";
import type { AppRole } from "./roles";
import { getSession, isExpiringSoon, type Session } from "./session";

/**
 * Page-level guard for Server Components. proxy.ts only does an optimistic cookie check, so pages
 * re-verify here (close to the data). Server Components cannot write cookies, therefore an expired
 * access token is handled by bouncing through /api/auth/refresh, a Route Handler that can.
 * With `role`, a logged-in user who lacks it gets a real HTTP 403: forbidden() renders the nearest
 * forbidden.tsx. It also writes the one log line per page request (status 307 / 403 / 200).
 * `redirect()` and `forbidden()` throw special errors — never wrap this call in try/catch.
 */
export async function requirePageSession(path: string, { role }: { role?: AppRole } = {}): Promise<Session> {
  const session = await getSession();
  const returnTo = encodeURIComponent(path);
  if (!session) {
    logPage(path, 307);
    redirect(`/api/auth/login?returnTo=${returnTo}`);
  }
  if (isExpiringSoon(session)) {
    logPage(path, 307, session);
    redirect(session.refreshToken ? `/api/auth/refresh?returnTo=${returnTo}` : `/api/auth/login?returnTo=${returnTo}`);
  }
  if (role && !session.roles.includes(role)) {
    logPage(path, 403, session);
    forbidden();
  }
  logPage(path, 200, session);
  return session;
}
