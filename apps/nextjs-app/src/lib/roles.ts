/**
 * Role extraction — the same rule every app in this repository uses:
 *  - read ROLES_CLAIM as a dotted path from the decoded ACCESS token
 *    ("roles" for the mock IdP / Entra, "realm_access.roles" for Keycloak, "groups" for Oracle),
 *  - the value may be an array of strings or a space-separated string (like `scp`/`scope`),
 *  - the user has app role X when that list contains ROLE_X,
 *  - a missing claim means "authenticated, but no roles".
 * Pure functions (no framework imports) so they are unit-testable with node --test.
 */
import { decodeJwt } from "jose";

export type AppRole = "user" | "admin";

export interface RoleRules {
  rolesClaim: string;
  roleUser: string;
  roleAdmin: string;
}

export type Claims = Record<string, unknown>;

/** Walks a dotted path ("realm_access.roles") through nested objects; undefined when any segment is missing. */
export function readClaimPath(claims: Claims | undefined, path: string): unknown {
  let current: unknown = claims;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Claims)[segment];
  }
  return current;
}

/** Raw role/group values found at the configured path, normalised to a string array. */
export function rawRoles(claims: Claims | undefined, rolesClaim: string): string[] {
  const value = readClaimPath(claims, rolesClaim);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(" ").filter(Boolean);
  return [];
}

/** Maps IdP-specific values to the two application roles. `admin` does NOT imply `user`. */
export function appRoles(claims: Claims | undefined, rules: RoleRules): AppRole[] {
  const raw = rawRoles(claims, rules.rolesClaim);
  const roles: AppRole[] = [];
  if (raw.includes(rules.roleUser)) roles.push("user");
  if (raw.includes(rules.roleAdmin)) roles.push("admin");
  return roles;
}

/** Decodes a JWT payload WITHOUT verifying it; returns undefined for opaque (non-JWT) tokens. */
export function decodeClaims(token: string | undefined): Claims | undefined {
  if (!token) return undefined;
  try {
    return decodeJwt(token) as Claims;
  } catch {
    return undefined;
  }
}

/**
 * Roles for the session: taken from the access token (the artefact the APIs authorise on).
 * The access token came straight from the IdP's token endpoint over a server-to-server call,
 * so decoding it without signature verification is safe here — the APIs still verify it.
 * If the IdP issues opaque access tokens, fall back to the (already validated) ID token claims.
 */
export function rolesFromTokens(accessToken: string, idTokenClaims: Claims | undefined, rules: RoleRules): AppRole[] {
  const access = decodeClaims(accessToken);
  if (access && readClaimPath(access, rules.rolesClaim) !== undefined) return appRoles(access, rules);
  return appRoles(idTokenClaims, rules);
}
