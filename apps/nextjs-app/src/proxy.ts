import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { logRequest } from "@/lib/log";
import { keyFromHex, unseal, SESSION_COOKIE, type Session } from "@/lib/session-crypto";

/**
 * Next.js 16 proxy (formerly middleware). It runs on the Node.js runtime before the protected pages
 * and does exactly one cheap, optimistic thing: can the session cookie be decrypted? If not, send the
 * browser to /api/auth/login and come back afterwards. No network calls, no token refresh here —
 * pages and Route Handlers re-verify the session close to the data (see lib/auth.ts and lib/tokens.ts).
 * Only the redirect is logged here; a page that passes through logs its own final status.
 */
export async function proxy(request: NextRequest) {
  const startedAt = Date.now();
  const { pathname, search } = request.nextUrl;
  const cfg = getConfig();
  let session: Session | null = null;
  try {
    session = await unseal<Session>(request.cookies.get(SESSION_COOKIE)?.value, keyFromHex(cfg.sessionSecret));
  } catch {
    session = null; // misconfigured SESSION_SECRET: treat as logged out, readyz reports the details
  }
  if (session) return NextResponse.next();
  // A logged-out visitor's browser prefetches the nav links in the background. Redirecting such a
  // prefetch would chain it to the IdP (cross-origin, blocked by CORS, noisy console); answer 401 instead
  // and let the real click take the normal redirect path.
  if (isPrefetch(request)) {
    logRequest(request, 401, startedAt);
    return new NextResponse(null, { status: 401 });
  }
  const login = new URL("/api/auth/login", cfg.publicUrl); // public URL, never request.url (pod host)
  login.searchParams.set("returnTo", pathname + search);
  logRequest(request, 307, startedAt);
  return NextResponse.redirect(login);
}

function isPrefetch(request: NextRequest): boolean {
  const h = request.headers;
  return h.get("next-router-prefetch") === "1" || h.has("next-router-segment-prefetch") || h.get("purpose") === "prefetch";
}

/** Only these page trees are guarded; /api/*, static assets and public pages are never touched. */
export const config = {
  matcher: ["/dashboard/:path*", "/orders/:path*", "/admin/:path*", "/graphql/:path*", "/profile/:path*"],
};
