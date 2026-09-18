/** Small role chips; `admin` gets an accent colour. Empty list renders a muted "no roles". */
export function RolesBadges({ roles }: { roles: string[] }) {
  if (roles.length === 0) return <span className="badge badge-muted">no roles</span>;
  return (
    <span className="badges">
      {roles.map((r) => (
        <span key={r} className={`badge ${r === "admin" ? "badge-admin" : "badge-user"}`}>
          {r}
        </span>
      ))}
    </span>
  );
}
