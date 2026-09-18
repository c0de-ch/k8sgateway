package auth_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth/authtest"
)

func httptestHandler(body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) })
}

// echo writes the principal so tests can inspect what handlers would see.
var echo = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.FromContext(r.Context())
	_ = json.NewEncoder(w).Encode(map[string]any{"sub": p.Subject, "roles": p.Roles, "user": p.Username()})
})

func newAuthenticator(t *testing.T, idp *authtest.IdP, rolesClaim string) *auth.Authenticator {
	t.Helper()
	a := &auth.Authenticator{Realm: "test", RolesClaim: rolesClaim,
		Roles: auth.RoleNames{User: "user", Admin: "admin"}, Log: slog.New(slog.DiscardHandler)}
	a.SetVerifier(newVerifier(t, idp, nil))
	return a
}

func do(h http.Handler, method, path, authorization string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestMiddleware(t *testing.T) {
	idp := authtest.New(t)
	h := newAuthenticator(t, idp, "roles").Middleware(echo)

	expired := idp.Claims("alice")
	expired["exp"] = time.Now().Add(-10 * time.Minute).Unix()

	cases := []struct {
		name, authorization string
		wantStatus          int
		wantChallenge       string // substring of WWW-Authenticate
		wantBody            string // substring of the body
	}{
		{"no header", "", 401, `Bearer realm="test"`, `"error_description":"missing bearer token"`},
		{"wrong scheme", "Basic YWxpY2U6YWxpY2U=", 401, `Bearer realm="test"`, `"error":"unauthorized"`},
		{"empty bearer", "Bearer ", 401, `Bearer realm="test"`, `missing bearer token`},
		{"garbage", "Bearer not-a-token", 401, `error="invalid_token"`, `"error":"unauthorized"`},
		{"expired", "Bearer " + idp.Sign(t, expired), 401, `error_description="token expired"`, `"error_description":"token expired"`},
		{"alice", "Bearer " + idp.Token(t, "alice"), 200, "", `"roles":["admin","user"]`},
		{"lower-case scheme", "bearer " + idp.Token(t, "bob"), 200, "", `"roles":["user"]`},
		{"carol has no roles", "Bearer " + idp.Token(t, "carol"), 200, "", `"roles":[]`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := do(h, http.MethodGet, "/api/me", c.authorization)
			if rec.Code != c.wantStatus {
				t.Fatalf("status %d, want %d (body %s)", rec.Code, c.wantStatus, rec.Body)
			}
			if got := rec.Header().Get("WWW-Authenticate"); !strings.Contains(got, c.wantChallenge) {
				t.Fatalf("WWW-Authenticate %q does not contain %q", got, c.wantChallenge)
			}
			if !strings.Contains(rec.Body.String(), c.wantBody) {
				t.Fatalf("body %s does not contain %s", rec.Body, c.wantBody)
			}
			if rec.Code == 401 && rec.Header().Get("Content-Type") != "application/json; charset=utf-8" {
				t.Fatalf("401 must be JSON, got %q", rec.Header().Get("Content-Type"))
			}
		})
	}

	// Missing-token challenge carries no error code (RFC 6750 section 3.1).
	if got := do(h, http.MethodGet, "/", "").Header().Get("WWW-Authenticate"); got != `Bearer realm="test"` {
		t.Fatalf("challenge without credentials: %q", got)
	}
}

func TestMiddleware_NotReady(t *testing.T) {
	a := &auth.Authenticator{Realm: "test", Log: slog.New(slog.DiscardHandler)}
	rec := do(a.Middleware(echo), http.MethodGet, "/api/me", "Bearer x")
	if rec.Code != http.StatusServiceUnavailable || a.Ready() {
		t.Fatalf("expected 503 while no verifier is attached, got %d", rec.Code)
	}
}

func TestMiddleware_KeycloakRolesClaim(t *testing.T) {
	idp := authtest.New(t)
	h := newAuthenticator(t, idp, "realm_access.roles").Middleware(echo)
	c := idp.Claims("alice")
	delete(c, "roles")
	c["realm_access"] = map[string]any{"roles": []string{"default-roles-demo", "offline_access", "admin", "user"}}
	rec := do(h, http.MethodGet, "/", "Bearer "+idp.Sign(t, c))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"roles":["admin","user"]`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	// preferred_username missing (Oracle sends sub=username instead) -> owner falls back to sub
	delete(c, "preferred_username")
	rec = do(h, http.MethodGet, "/", "Bearer "+idp.Sign(t, c))
	if !strings.Contains(rec.Body.String(), `"user":"uuid-alice"`) {
		t.Fatalf("%s", rec.Body)
	}
}

func TestRequireRole(t *testing.T) {
	idp := authtest.New(t)
	a := newAuthenticator(t, idp, "roles")
	admin := a.Middleware(auth.RequireRole(auth.RoleAdmin)(echo))
	user := a.Middleware(auth.RequireRole(auth.RoleUser)(echo))

	cases := []struct {
		name string
		h    http.Handler
		user string
		want int
	}{
		{"alice admin", admin, "alice", 200}, {"alice user", user, "alice", 200},
		{"bob admin", admin, "bob", 403}, {"bob user", user, "bob", 200},
		{"carol admin", admin, "carol", 403}, {"carol user", user, "carol", 403},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := do(c.h, http.MethodGet, "/", "Bearer "+idp.Token(t, c.user))
			if rec.Code != c.want {
				t.Fatalf("status %d, want %d", rec.Code, c.want)
			}
			if c.want == 403 {
				var body map[string]string
				_ = json.Unmarshal(rec.Body.Bytes(), &body)
				if body["error"] != "forbidden" || (body["required_role"] != "admin" && body["required_role"] != "user") {
					t.Fatalf("403 body %s", rec.Body)
				}
				if !strings.Contains(rec.Header().Get("WWW-Authenticate"), `error="insufficient_scope"`) {
					t.Fatalf("challenge %q", rec.Header().Get("WWW-Authenticate"))
				}
			}
		})
	}
	// RequireRole without the authentication middleware in front -> 401, never a panic.
	if rec := do(auth.RequireRole("admin")(echo), http.MethodGet, "/", ""); rec.Code != 401 {
		t.Fatalf("got %d", rec.Code)
	}
	if _, ok := auth.FromContext(context.Background()); ok {
		t.Fatal("no principal expected")
	}
}
