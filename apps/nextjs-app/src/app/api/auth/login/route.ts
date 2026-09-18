import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { errorSummary, log, logRequest } from "@/lib/log";
import { authErrorUrl, buildLoginUrl } from "@/lib/oidc";
import { setLoginTransaction } from "@/lib/session";
import { safeReturnTo } from "@/lib/session-crypto";

/**
 * GET /api/auth/login?returnTo=/orders
 * Step 1 of the code flow: create PKCE verifier + state + nonce, remember them in an encrypted,
 * short-lived transaction cookie, and send the browser to the IdP's authorization endpoint.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const cfg = getConfig();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  try {
    const { url, codeVerifier, state, nonce } = await buildLoginUrl(cfg);
    await setLoginTransaction({ codeVerifier, state, nonce, returnTo });
    logRequest(request, 307, startedAt);
    return NextResponse.redirect(url);
  } catch (err) {
    log.error("login start failed", errorSummary(err));
    logRequest(request, 307, startedAt);
    return NextResponse.redirect(authErrorUrl(cfg.publicUrl, err));
  }
}

