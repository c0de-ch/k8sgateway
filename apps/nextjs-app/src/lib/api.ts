import "server-only";
import { getConfig } from "./config";
import { errorSummary, log } from "./log";

/**
 * Server-side calls to the backend APIs. The access token is attached here, on the server:
 * this is the "token relay" half of the BFF pattern. Always `cache: 'no-store'` — never let Next.js
 * cache one user's data for another, and never prerender these calls at build time.
 */
const UPSTREAM_TIMEOUT_MS = 10_000;

export function restFetch(path: string, accessToken: string, init: { method?: string; body?: string } = {}): Promise<Response> {
  const { restApiInternalUrl } = getConfig();
  return fetch(`${restApiInternalUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

export function graphqlFetch(body: { query: string; variables?: unknown; operationName?: string }, accessToken: string): Promise<Response> {
  const { graphqlInternalUrl } = getConfig();
  return fetch(graphqlInternalUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

/** JSON body if parseable, otherwise the raw text wrapped in an object. */
export async function readJson<T = unknown>(res: Response): Promise<T | { raw: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { raw: text };
  }
}

/**
 * Relays an upstream response to the browser: same status, same JSON body, plus the WWW-Authenticate
 * header on 401 so the browser-side code can show WHY the API refused the token. Network failures
 * become a 502 with a small JSON body — never a stack trace.
 */
export async function relay(upstream: Promise<Response>): Promise<Response> {
  try {
    const res = await upstream;
    // Per-user data: no intermediary (or a plain <a href="/api/bff/orders"> in the browser cache) may keep it.
    const headers = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
    const challenge = res.headers.get("www-authenticate");
    if (challenge) headers.set("www-authenticate", challenge);
    return new Response(await res.text(), { status: res.status, headers });
  } catch (err) {
    log.error("upstream call failed", errorSummary(err));
    return Response.json(
      { error: "upstream_unavailable", error_description: "the backend API did not answer" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
