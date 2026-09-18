import type { Metadata } from "next";
import { readJson, restFetch } from "@/lib/api";
import { requirePageSession } from "@/lib/auth";
import { errorSummary, log } from "@/lib/log";
import { ApiStatusBanner } from "@/components/banner";
import { JsonPanel } from "@/components/json-panel";

export const metadata: Metadata = { title: "Admin" };

/**
 * Server-side role check: requirePageSession(..., { role: "admin" }) answers HTTP 403 (forbidden.tsx next to
 * this file) for logged-in users without the role. The REST API enforces the admin role on its own as well
 * (defence in depth) — you can see both layers agree.
 */
export default async function AdminPage() {
  const session = await requirePageSession("/admin", { role: "admin" });
  let status = 0;
  let stats: unknown = null;
  try {
    const res = await restFetch("/api/admin/stats", session.accessToken);
    status = res.status;
    stats = await readJson(res);
  } catch (err) {
    status = 502;
    log.error("admin stats failed", errorSummary(err));
  }
  return (
    <>
      <h1>Admin</h1>
      <p className="lead">
        Statistics from <code>GET /api/admin/stats</code>, fetched server-side with your bearer token.
      </p>
      <section className="card">
        <h2>
          Stats <span className="card-title-note">HTTP {status}</span>
        </h2>
        <ApiStatusBanner status={status} returnTo="/admin" requiredRole="admin" />
        {stats !== null && <JsonPanel value={stats} />}
      </section>
    </>
  );
}
