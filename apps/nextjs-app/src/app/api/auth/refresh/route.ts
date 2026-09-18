import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { logRequest } from "@/lib/log";
import { isExpiringSoon } from "@/lib/session";
import { safeReturnTo } from "@/lib/session-crypto";
import { requireApiSession } from "@/lib/tokens";

/**
 * GET /api/auth/refresh?returnTo=/dashboard
 * Used by Server Component pages when the access token has expired: they cannot write cookies,
 * so they bounce through this Route Handler, which refreshes, rewrites the cookie and sends the user back.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const cfg = getConfig();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  const result = await requireApiSession();
  if (!result.ok || isExpiringSoon(result.session)) {
    // no session, refresh failed, or the IdP handed out an already-expired token: start a new login
    logRequest(request, 307, startedAt);
    return NextResponse.redirect(new URL(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`, cfg.publicUrl));
  }
  logRequest(request, 307, startedAt, result.session);
  return NextResponse.redirect(new URL(returnTo, cfg.publicUrl));
}
