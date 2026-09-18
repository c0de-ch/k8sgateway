import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { errorSummary, log, logRequest } from "@/lib/log";
import { endSessionUrl } from "@/lib/oidc";
import { clearSession, getSession } from "@/lib/session";

/**
 * GET /api/auth/logout
 * Deletes the local session and, when the IdP advertises an end_session_endpoint, performs
 * RP-initiated logout there (id_token_hint + post_logout_redirect_uri) so the IdP's SSO session ends too.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const cfg = getConfig();
  const session = await getSession();
  await clearSession();
  let target = new URL("/", cfg.publicUrl);
  if (session) {
    try {
      target = (await endSessionUrl(cfg, session.idToken)) ?? target;
    } catch (err) {
      log.warn("end_session lookup failed, local logout only", errorSummary(err)); // IdP down: still log out locally
    }
  }
  logRequest(request, 307, startedAt, session);
  return NextResponse.redirect(target);
}
