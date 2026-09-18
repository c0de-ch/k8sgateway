import { configProblems, getConfig } from "@/lib/config";
import { keyFromHex } from "@/lib/session-crypto";

/** Readiness: the configuration is usable (a bad SESSION_SECRET or OIDC_CLIENT_AUTH would make every login fail). */
export function GET() {
  const cfg = getConfig();
  const problems = configProblems();
  try {
    keyFromHex(cfg.sessionSecret);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : "invalid SESSION_SECRET");
  }
  if (problems.length > 0) return Response.json({ status: "not_ready", reason: problems.join("; ") }, { status: 503 });
  return Response.json({ status: "ready", issuer: cfg.oidcIssuer, idp: cfg.idpName });
}
