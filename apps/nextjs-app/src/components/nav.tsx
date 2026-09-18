import Link from "next/link";
import { getConfig } from "@/lib/config";
import { getSession } from "@/lib/session";
import { RolesBadges } from "./roles-badges";

/**
 * Top navigation, rendered on the server from the session cookie. Login/Logout are plain links to
 * Route Handlers (full navigations), so the layout is always fresh after the auth state changes.
 */
export async function Nav() {
  const session = await getSession();
  const { idpName } = getConfig();
  const isAdmin = session?.roles.includes("admin") ?? false;
  // Protected pages redirect anonymous visitors to the IdP: do not prefetch them while logged out.
  const prefetch = session ? undefined : false;
  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden>
            ▣
          </span>
          Next.js BFF
        </Link>
        <span className="badge badge-idp" title="OIDC_IDP_NAME">
          {idpName}
        </span>
        <nav className="nav-links" aria-label="Main">
          <Link href="/dashboard" prefetch={prefetch}>Dashboard</Link>
          <Link href="/orders" prefetch={prefetch}>Orders</Link>
          {isAdmin && <Link href="/admin" prefetch={prefetch}>Admin</Link>}
          <Link href="/graphql" prefetch={prefetch}>GraphQL</Link>
          <Link href="/profile" prefetch={prefetch}>Profile</Link>
        </nav>
        <div className="nav-user">
          {session ? (
            <>
              <span className="user-name" title={session.sub}>
                {session.name ?? session.preferredUsername ?? session.sub}
              </span>
              <RolesBadges roles={session.roles} />
              <a className="btn btn-ghost" href="/api/auth/logout">
                Logout
              </a>
            </>
          ) : (
            <a className="btn btn-primary" href="/api/auth/login?returnTo=%2Fdashboard">
              Login
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
