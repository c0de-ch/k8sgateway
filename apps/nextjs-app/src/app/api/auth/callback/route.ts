import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { errorSummary, log, logRequest } from "@/lib/log";
import { authErrorUrl, handleCallback } from "@/lib/oidc";
import { setSession, takeLoginTransaction } from "@/lib/session";
import { sessionFromTokens } from "@/lib/tokens";

/**
 * GET /api/auth/callback?code=...&state=...
 * Step 2: the IdP sent the browser back. Exchange the code (server-to-server, with client secret and
 * PKCE verifier), validate the ID token, and store the tokens in the encrypted session cookie.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const cfg = getConfig();
  const txn = await takeLoginTransaction(); // single use: deleted whether or not the exchange succeeds
  if (!txn) {
    logRequest(request, 307, startedAt);
    return NextResponse.redirect(
      authErrorUrl(cfg.publicUrl, { error: "missing_transaction", description: "login transaction cookie missing or expired — start the login again" }),
    );
  }
  try {
    const tokens = await handleCallback(cfg, request.nextUrl.search, txn);
    const claims = tokens.claims(); // ID token claims, already validated by openid-client
    const session = await setSession(sessionFromTokens(tokens, claims));
    log.info("login ok", { sub: session.sub, roles: session.roles, expiresAt: session.expiresAt, idTokenDropped: !!session.idTokenDropped });
    logRequest(request, 307, startedAt, session);
    return NextResponse.redirect(new URL(txn.returnTo, cfg.publicUrl));
  } catch (err) {
    log.error("callback failed", errorSummary(err));
    logRequest(request, 307, startedAt);
    return NextResponse.redirect(authErrorUrl(cfg.publicUrl, err));
  }
}
