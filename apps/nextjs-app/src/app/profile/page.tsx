import type { Metadata } from "next";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { getConfig } from "@/lib/config";
import { requirePageSession } from "@/lib/auth";
import { rawRoles } from "@/lib/roles";
import { Banner } from "@/components/banner";
import { Countdown } from "@/components/countdown";
import { JsonPanel } from "@/components/json-panel";
import { RolesBadges } from "@/components/roles-badges";

export const metadata: Metadata = { title: "Profile" };

/**
 * Shows the access token DECODED ON THE SERVER. The token value itself is never sent to the browser —
 * only its header and claims are, which are not secret (anyone holding a JWT can read them).
 */
export default async function ProfilePage() {
  const session = await requirePageSession("/profile");
  const cfg = getConfig();
  const decoded = safeDecode(session.accessToken);
  const idClaims = session.idToken ? safeDecode(session.idToken) : null;

  return (
    <>
      <h1>Profile</h1>
      <p className="lead">
        What the BFF knows about you, and the access token it relays to the APIs on your behalf — decoded server-side.
      </p>
      <Banner kind="info" title="Why there is no “copy token” or “copy curl” button">
        In the BFF model the browser never receives the access token; that is the security property this app demonstrates. Handing you
        the token here would recreate the SPA threat model (a token readable by page scripts). To call the APIs from a terminal, mint your
        own token with <code>scripts/get-token.sh &lt;user&gt;</code> — the CLI client exists for exactly that.
      </Banner>

      <div className="grid">
        <section className="card">
          <h2>Session</h2>
          <table className="kv">
            <tbody>
              <tr>
                <td>Identity provider</td>
                <td>{cfg.idpName}</td>
              </tr>
              <tr>
                <td>Subject</td>
                <td className="mono">{session.sub}</td>
              </tr>
              <tr>
                <td>Roles (app)</td>
                <td>
                  <RolesBadges roles={session.roles} />
                </td>
              </tr>
              <tr>
                <td>
                  Raw <code>{cfg.rolesClaim}</code> claim
                </td>
                <td className="mono">{decoded ? rawRoles(decoded.payload, cfg.rolesClaim).join(", ") || "—" : "—"}</td>
              </tr>
              <tr>
                <td>Access token expires in</td>
                <td>
                  <Countdown epochSeconds={session.expiresAt} />
                </td>
              </tr>
              <tr>
                <td>Refresh token</td>
                <td>{session.refreshToken ? "present (server-side only)" : "none"}</td>
              </tr>
              <tr>
                <td>ID token</td>
                <td>{session.idToken ? "stored" : session.idTokenDropped ? "dropped (cookie size)" : "none"}</td>
              </tr>
              <tr>
                <td>Session cookie</td>
                <td className="small">
                  <code>k8sgw_session</code>, httpOnly, SameSite=Lax, {cfg.publicUrl.startsWith("https://") ? "Secure" : "not Secure (http)"},
                  JWE dir/A256GCM
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Access token · header</h2>
          {decoded ? <JsonPanel value={decoded.header} /> : <Banner kind="warn">The access token is opaque (not a JWT).</Banner>}
          <h2 style={{ marginTop: "1rem" }}>Access token · payload</h2>
          {decoded && <JsonPanel value={decoded.payload} />}
          <p className="muted small">
            <code>aud</code> must contain the API audience, <code>iss</code> must equal the configured issuer. Both are checked by the APIs on
            every request.
          </p>
        </section>

        {idClaims && (
          <section className="card">
            <h2>ID token · payload</h2>
            <JsonPanel value={idClaims.payload} />
            <p className="muted small">
              Validated by openid-client during the callback: signature (against the IdP&apos;s JWKS), <code>iss</code>,{" "}
              <code>aud</code> = client_id, <code>exp</code>, <code>nonce</code>.
            </p>
          </section>
        )}
      </div>
    </>
  );
}

function safeDecode(token: string): { header: unknown; payload: Record<string, unknown> } | null {
  try {
    return { header: decodeProtectedHeader(token), payload: decodeJwt(token) as Record<string, unknown> };
  } catch {
    return null;
  }
}
