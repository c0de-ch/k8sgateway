package auth_test

import (
	"reflect"
	"testing"

	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth"
)

func TestRolesFromClaims(t *testing.T) {
	claims := map[string]any{
		"roles":           []any{"admin", "user", 42, nil}, // non-strings are skipped
		"realm_access":    map[string]any{"roles": []any{"user", "offline_access"}},
		"resource_access": map[string]any{"k8sgateway-api": map[string]any{"roles": []any{"admin"}}},
		"scp":             "access_as_user  orders.read", // Entra: space separated string
		"groups":          []any{"11111111-2222-3333-4444-555555555555"},
		"nested":          map[string]any{"x": 1.0},
	}
	cases := []struct {
		path string
		want []string
	}{
		{"roles", []string{"admin", "user"}},
		{"realm_access.roles", []string{"user", "offline_access"}},
		{"resource_access.k8sgateway-api.roles", []string{"admin"}},
		{"scp", []string{"access_as_user", "orders.read"}},
		{"groups", []string{"11111111-2222-3333-4444-555555555555"}},
		{"missing", nil},
		{"realm_access.missing", nil},
		{"nested.x", nil},     // number, not a list
		{"roles.deeper", nil}, // cannot descend into an array
		{"", nil},
	}
	for _, c := range cases {
		if got := auth.RolesFromClaims(claims, c.path); !reflect.DeepEqual(got, c.want) {
			t.Errorf("RolesFromClaims(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestAppRoles(t *testing.T) {
	def := auth.RoleNames{User: "user", Admin: "admin"}
	guid := auth.RoleNames{User: "app-user", Admin: "d3b07384-d9a0-4f1a-9a3e-000000000001"} // Entra group ids
	cases := []struct {
		names auth.RoleNames
		raw   []string
		want  []string
	}{
		{def, []string{"admin", "user", "offline_access"}, []string{"admin", "user"}},
		{def, []string{"user"}, []string{"user"}},
		{def, []string{"admin"}, []string{"admin"}}, // admin does not imply user
		{def, nil, []string{}},
		{def, []string{"ADMIN"}, []string{}}, // case sensitive
		{guid, []string{"d3b07384-d9a0-4f1a-9a3e-000000000001", "app-user"}, []string{"admin", "user"}},
		{auth.RoleNames{}, []string{"admin"}, []string{}},
	}
	for _, c := range cases {
		if got := c.names.AppRoles(c.raw); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%+v.AppRoles(%v) = %v, want %v", c.names, c.raw, got, c.want)
		}
	}
}
