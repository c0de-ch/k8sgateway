import { getSession } from "@/lib/session";
import { Banner } from "@/components/banner";
import { RolesBadges } from "@/components/roles-badges";

/** Rendered with HTTP status 403 when /admin calls forbidden() for a logged-in user without the admin role. */
export default async function AdminForbidden() {
  const session = await getSession();
  return (
    <>
      <h1>Admin</h1>
      <Banner kind="error" title="403 — admin role required">
        {session && (
          <>
            You are logged in as <strong>{session.name ?? session.sub}</strong> with roles <RolesBadges roles={session.roles} />.{" "}
          </>
        )}
        The <code>admin</code> role is granted by the identity provider (mapped via <code>ROLES_CLAIM</code> and <code>ROLE_ADMIN</code>), not by
        this app. Log out and sign in as <code>alice</code> to see the statistics.
      </Banner>
      <p className="muted small">
        Even if this page were bypassed, the REST endpoint <code>/api/admin/stats</code> would still answer 403 for this token.
      </p>
    </>
  );
}
