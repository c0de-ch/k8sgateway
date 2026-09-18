import type { Metadata } from "next";
import Link from "next/link";
import { getConfig } from "@/lib/config";
import { logPage } from "@/lib/log";
import { Banner } from "@/components/banner";

export const metadata: Metadata = { title: "Login failed" };

const HINTS: Record<string, string> = {
  idp_unreachable: "The BFF could not reach the identity provider. Check OIDC_ISSUER, DNS from inside the pod and that the IdP is running.",
  missing_transaction: "The login took longer than 10 minutes, cookies are blocked, or the callback was opened directly.",
  access_denied: "You cancelled the login or the identity provider refused to issue tokens for this client.",
  invalid_grant: "The authorization code was already used, expired, or the redirect_uri did not match the registered one.",
  invalid_client: "Client id / secret or the token-endpoint authentication method (OIDC_CLIENT_AUTH) is wrong.",
  unauthorized_client: "The client is not allowed to use the authorization code grant or this redirect URI at the IdP.",
  OAUTH_KEY_SELECTION_FAILED: "The ID token is signed with a key that is not in the JWKS the BFF fetched — check OIDC_JWKS_URI (or the IdP's jwks_uri) and its signing keys.",
};

/** Friendly error page for failed logins; the details come from the query string, never from a stack trace. */
export default async function AuthErrorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = first(params.error) ?? "auth_failed";
  const description = first(params.error_description) ?? "";
  const { idpName, oidcIssuer } = getConfig();
  logPage("/auth/error", 200);
  return (
    <>
      <h1>Login failed</h1>
      <p className="lead">
        Signing in at <strong>{idpName}</strong> did not complete.
      </p>
      <Banner kind="error" title={error}>
        {description}
      </Banner>
      {HINTS[error] && <p>{HINTS[error]}</p>}
      <p className="muted small">
        Issuer: <code>{oidcIssuer}</code>
      </p>
      <div className="row">
        <a className="btn btn-primary" href="/api/auth/login?returnTo=%2Fdashboard">
          Try again
        </a>
        <Link className="btn" href="/">
          Back to start
        </Link>
      </div>
    </>
  );
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
