import type { ReactNode } from "react";

export type BannerKind = "info" | "warn" | "error" | "ok";

/** Inline status banner: info (blue), warn (amber), error (red), ok (green). */
export function Banner({ kind = "info", title, children }: { kind?: BannerKind; title?: string; children?: ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

/** Explains a 401/403 from the API in plain words; returns null for other statuses. */
export function ApiStatusBanner({ status, returnTo, requiredRole }: { status: number; returnTo: string; requiredRole?: string }) {
  if (status === 401) {
    return (
      <Banner kind="warn" title="Session expired or missing (401)">
        The API rejected the token relayed by the BFF. <a href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>Log in again</a>.
      </Banner>
    );
  }
  if (status === 403) {
    return (
      <Banner kind="error" title="Forbidden (403)">
        You are authenticated, but your account lacks the <code>{requiredRole ?? "required"}</code> role. Roles come from the identity
        provider (claim configured with <code>ROLES_CLAIM</code>) — try <code>alice</code> (admin, user), <code>bob</code> (user) or{" "}
        <code>carol</code> (no roles).
      </Banner>
    );
  }
  if (status === 502) {
    return (
      <Banner kind="error" title="Backend unavailable (502)">
        The BFF could not reach the API. Check <code>REST_API_INTERNAL_URL</code> / <code>GRAPHQL_INTERNAL_URL</code> and the API pods.
      </Banner>
    );
  }
  return null;
}
