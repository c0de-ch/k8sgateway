import type { Metadata } from "next";
import { readJson, restFetch } from "@/lib/api";
import { requirePageSession } from "@/lib/auth";
import { errorSummary, log } from "@/lib/log";
import { ApiStatusBanner } from "@/components/banner";
import { JsonPanel } from "@/components/json-panel";
import { RolesBadges } from "@/components/roles-badges";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Server Component: reads the session and calls the REST API's /api/me on the server with the
 * bearer token. Nothing here runs in the browser; the HTML arrives already rendered.
 */
export default async function DashboardPage() {
  const session = await requirePageSession("/dashboard");
  let status = 0;
  let me: unknown = null;
  try {
    const res = await restFetch("/api/me", session.accessToken);
    status = res.status;
    me = await readJson(res);
  } catch (err) {
    status = 502;
    log.error("dashboard /api/me failed", errorSummary(err));
  }

  return (
    <>
      <h1>Dashboard</h1>
      <p className="lead">Rendered on the server from the session cookie and a server-to-server call to the REST API.</p>
      <div className="grid">
        <section className="card">
          <h2>Session</h2>
          <table className="kv">
            <tbody>
              <tr>
                <td>Name</td>
                <td>{session.name ?? "—"}</td>
              </tr>
              <tr>
                <td>Username</td>
                <td>{session.preferredUsername ?? "—"}</td>
              </tr>
              <tr>
                <td>Email</td>
                <td>{session.email ?? "—"}</td>
              </tr>
              <tr>
                <td>Subject</td>
                <td className="mono">{session.sub}</td>
              </tr>
              <tr>
                <td>Roles</td>
                <td>
                  <RolesBadges roles={session.roles} />
                </td>
              </tr>
              <tr>
                <td>Access token expires</td>
                <td className="mono">{new Date(session.expiresAt * 1000).toISOString()}</td>
              </tr>
              <tr>
                <td>Logged in at</td>
                <td className="mono">{new Date(session.authTime * 1000).toISOString()}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>
            GET /api/me <span className="card-title-note">REST API, called server-side</span>
          </h2>
          <p className="status-code">HTTP {status}</p>
          <ApiStatusBanner status={status} returnTo="/dashboard" />
          {me !== null && <JsonPanel value={me} />}
          <p className="muted small">
            The API validated the JWT (signature via JWKS, <code>iss</code>, <code>aud</code>, <code>exp</code>) and echoed the claims it
            trusts.
          </p>
        </section>
      </div>
    </>
  );
}
