import type { NextRequest } from "next/server";
import { relay, restFetch } from "@/lib/api";
import { logRequest } from "@/lib/log";
import { requireApiSession } from "@/lib/tokens";

/** GET /api/bff/admin/stats — relay to the REST API's admin-only endpoint (403 for non-admins comes from the API). */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const auth = await requireApiSession();
  if (!auth.ok) {
    logRequest(request, 401, startedAt);
    return auth.response;
  }
  const res = await relay(restFetch("/api/admin/stats", auth.session.accessToken));
  logRequest(request, res.status, startedAt, auth.session);
  return res;
}
