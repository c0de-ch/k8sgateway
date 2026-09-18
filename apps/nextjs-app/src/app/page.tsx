import Link from "next/link";
import { getConfig } from "@/lib/config";
import { logPage } from "@/lib/log";
import { getSession } from "@/lib/session";

/** Public landing page: explains the BFF pattern and offers Login or "Continue to dashboard". */
export default async function Home() {
  const session = await getSession();
  const { idpName } = getConfig();
  logPage("/", 200, session);
  return (
    <>
      <section className="hero">
        <h1>A web app on Kubernetes where the browser never holds a token.</h1>
        <p className="lead">
          This Next.js 16 app is a <strong>backend-for-frontend (BFF)</strong>: it logs you in at <strong>{idpName}</strong> with OpenID
          Connect, keeps the JWTs in an encrypted cookie on the server and relays them to the REST and GraphQL APIs behind the Gateway.
        </p>
        <div className="row">
          {session ? (
            <Link className="btn btn-primary btn-lg" href="/dashboard">
              Continue to dashboard →
            </Link>
          ) : (
            <a className="btn btn-primary btn-lg" href="/api/auth/login?returnTo=%2Fdashboard">
              Login with {idpName}
            </a>
          )}
          <a className="btn btn-lg" href="/api/auth/session">
            View /api/auth/session
          </a>
        </div>
      </section>

      <div className="grid">
        <section className="card">
          <h2>How the BFF pattern works</h2>
          <ol className="steps">
            <li>
              <code>/api/auth/login</code> creates a PKCE verifier, <code>state</code> and <code>nonce</code>, stores them in a short-lived
              encrypted cookie and redirects you to the IdP.
            </li>
            <li>
              You authenticate at the IdP (the app never sees your password). The IdP redirects back to{" "}
              <code>/api/auth/callback?code=…&amp;state=…</code>.
            </li>
            <li>
              The server exchanges the code for tokens (client secret + PKCE verifier), validates the ID token (signature, issuer,
              audience, nonce) and writes the tokens into the <code>k8sgw_session</code> cookie — httpOnly, AES-256-GCM encrypted.
            </li>
            <li>
              Pages and <code>/api/bff/*</code> handlers read the cookie on the server and call the APIs with{" "}
              <code>Authorization: Bearer …</code>. The APIs validate the JWT themselves.
            </li>
            <li>Access tokens expire in minutes; the server refreshes them with the refresh token and rewrites the cookie.</li>
          </ol>
        </section>

        <section className="card">
          <h2>Why a BFF instead of a SPA with tokens?</h2>
          <ul>
            <li>No token in browser storage, so XSS cannot steal it.</li>
            <li>A confidential client: the IdP knows the app by a client secret, not only by a redirect URI.</li>
            <li>Refresh tokens stay on the server; the browser only carries an opaque-looking encrypted cookie.</li>
            <li>The trade-off: every API call goes through this server (one extra hop, session cookie CSRF rules apply).</li>
          </ul>
          <h3>Compare</h3>
          <p className="muted small">
            The Angular app in this repository shows the other model: a public client with PKCE that keeps the token in memory and
            calls the APIs directly.
          </p>
        </section>

        <section className="card">
          <h2>Demo users</h2>
          <table>
            <thead>
              <tr>
                <th>user</th>
                <th>password</th>
                <th>roles</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>alice</td>
                <td>alice</td>
                <td>admin, user</td>
              </tr>
              <tr>
                <td>bob</td>
                <td>bob</td>
                <td>user</td>
              </tr>
              <tr>
                <td>carol</td>
                <td>carol</td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">Mock IdP and Keycloak ship these users; with Entra ID or Oracle IAM you use your own accounts.</p>
        </section>
      </div>
    </>
  );
}
