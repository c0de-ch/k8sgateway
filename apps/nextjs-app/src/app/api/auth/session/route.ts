import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { logRequest } from "@/lib/log";
import { getSession } from "@/lib/session";

/**
 * GET /api/auth/session — what the browser may know about the login: identity, roles, expiry.
 * Tokens are deliberately NOT included; that is the whole point of the BFF pattern.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const session = await getSession();
  const body = session
    ? {
        authenticated: true,
        profile: { sub: session.sub, name: session.name, preferredUsername: session.preferredUsername, email: session.email },
        roles: session.roles,
        expiresAt: new Date(session.expiresAt * 1000).toISOString(),
        idp: getConfig().idpName,
      }
    : { authenticated: false, idp: getConfig().idpName };
  logRequest(request, 200, startedAt, session);
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
