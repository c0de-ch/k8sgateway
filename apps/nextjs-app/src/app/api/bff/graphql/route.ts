import type { NextRequest } from "next/server";
import { graphqlFetch, relay } from "@/lib/api";
import { logRequest } from "@/lib/log";
import { requireApiSession } from "@/lib/tokens";

/** POST /api/bff/graphql {query, variables} — relayed to the GraphQL API with the bearer token. */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const auth = await requireApiSession();
  if (!auth.ok) {
    logRequest(request, 401, startedAt);
    return auth.response;
  }
  let body: { query?: unknown; variables?: unknown; operationName?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (typeof body.query !== "string" || body.query.length > 10_000) {
    logRequest(request, 400, startedAt, auth.session);
    return Response.json({ error: "bad_request", error_description: "body must be JSON with a string `query`" }, { status: 400 });
  }
  const operationName = typeof body.operationName === "string" ? body.operationName : undefined;
  const res = await relay(graphqlFetch({ query: body.query, variables: body.variables, operationName }, auth.session.accessToken));
  logRequest(request, res.status, startedAt, auth.session);
  return res;
}
