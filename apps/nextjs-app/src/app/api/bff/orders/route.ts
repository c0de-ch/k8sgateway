import type { NextRequest } from "next/server";
import { relay, restFetch } from "@/lib/api";
import { logRequest } from "@/lib/log";
import { requireApiSession } from "@/lib/tokens";

/**
 * /api/bff/orders — the browser talks to us with its session cookie; we talk to the REST API with
 * the bearer token. The REST API enforces the "user" role; we simply relay its 200/401/403 answer.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const auth = await requireApiSession();
  if (!auth.ok) return finish(request, auth.response, startedAt);
  const res = await relay(restFetch("/api/orders", auth.session.accessToken));
  return finish(request, res, startedAt, auth.session);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const auth = await requireApiSession();
  if (!auth.ok) return finish(request, auth.response, startedAt);
  const body = await request.text(); // {item, quantity} — validated by the REST API, forwarded as-is
  const res = await relay(restFetch("/api/orders", auth.session.accessToken, { method: "POST", body }));
  return finish(request, res, startedAt, auth.session);
}

function finish(request: NextRequest, res: Response, startedAt: number, who?: { sub: string; roles: string[] }) {
  logRequest(request, res.status, startedAt, who);
  return res;
}
