// Package auth verifies OIDC access tokens (JWT) and turns their claims into a
// Principal with application roles. The IdP authenticates users and manages
// roles; this package only checks what the IdP signed.
package auth

import "strings"

// Role names used by the application. Which IdP value maps to them is
// configured with ROLE_USER / ROLE_ADMIN (see RoleNames).
const (
	RoleUser  = "user"
	RoleAdmin = "admin"
)

// RolesFromClaims reads the claim at a dotted path (ROLES_CLAIM), e.g.
// "roles", "realm_access.roles", "resource_access.k8sgateway-api.roles" or
// "scp". The value may be a JSON array of strings (Keycloak, Entra roles/groups)
// or one space-separated string (Entra "scp", RFC 9068 "scope"). A missing or
// differently typed claim yields no roles - the caller stays authenticated.
// Limitation: path segments are split on "." so a client id containing dots
// cannot be addressed.
func RolesFromClaims(claims map[string]any, path string) []string {
	var cur any = claims
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		if cur, ok = m[part]; !ok {
			return nil
		}
	}
	switch v := cur.(type) {
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case string:
		return strings.Fields(v)
	}
	return nil
}

// RoleNames holds the IdP values that grant the application roles.
type RoleNames struct {
	User  string // ROLE_USER, default "user"
	Admin string // ROLE_ADMIN, default "admin"
}

// AppRoles maps raw IdP values to application roles ("admin", "user").
// Anything else in the claim (Keycloak's default-roles-*, offline_access, ...)
// is ignored.
func (n RoleNames) AppRoles(raw []string) []string {
	roles := make([]string, 0, 2)
	if n.Admin != "" && contains(raw, n.Admin) {
		roles = append(roles, RoleAdmin)
	}
	if n.User != "" && contains(raw, n.User) {
		roles = append(roles, RoleUser)
	}
	return roles
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
