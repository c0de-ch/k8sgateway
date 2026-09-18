package api_test

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/api"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth/authtest"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/orders"
)

type app struct {
	h     http.Handler
	idp   *authtest.IdP
	ready error
}

func newApp(t *testing.T) *app {
	t.Helper()
	idp := authtest.New(t)
	a := &app{idp: idp}
	authn := &auth.Authenticator{Realm: "k8sgateway-api", RolesClaim: "roles",
		Roles: auth.RoleNames{User: "user", Admin: "admin"}, Log: slog.New(slog.DiscardHandler)}
	// The router works without a verifier (protected routes answer 503); attach one like main does.
	v, err := auth.NewVerifier(t.Context(), auth.Config{Issuer: idp.Issuer, Audiences: []string{idp.Audience}})
	if err != nil {
		t.Fatal(err)
	}
	authn.SetVerifier(v)
	a.h = api.NewRouter(api.Deps{
		Log: slog.New(slog.DiscardHandler), Auth: authn, Orders: orders.NewSeeded(),
		CORSOrigins: []string{"http://angular.127.0.0.1.nip.io", "http://next.127.0.0.1.nip.io"},
		Ready:       func() error { return a.ready },
		Started:     time.Now(),
	})
	return a
}

func (a *app) call(t *testing.T, user, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if user != "" {
		req.Header.Set("Authorization", "Bearer "+a.idp.Token(t, user))
	}
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	var obj map[string]any
	if strings.HasPrefix(rec.Body.String(), "{") {
		_ = json.Unmarshal(rec.Body.Bytes(), &obj)
	}
	return rec, obj
}

// TestMatrix is the 401/403/200 table from the tutorial: anonymous, alice
// (admin+user), bob (user) and carol (authenticated, no roles).
func TestMatrix(t *testing.T) {
	a := newApp(t)
	const order = `{"item":"Laptop","quantity":1}`
	cases := []struct {
		user, method, path, body string
		want                     int
	}{
		{"", "GET", "/api/public", "", 200},
		{"", "GET", "/api/me", "", 401},
		{"", "GET", "/api/orders", "", 401},
		{"", "POST", "/api/orders", order, 401},
		{"", "GET", "/api/admin/stats", "", 401},
		{"", "GET", "/api/admin/orders", "", 401},

		{"alice", "GET", "/api/public", "", 200},
		{"alice", "GET", "/api/me", "", 200},
		{"alice", "GET", "/api/orders", "", 200},
		{"alice", "POST", "/api/orders", order, 201},
		{"alice", "GET", "/api/admin/stats", "", 200},
		{"alice", "GET", "/api/admin/orders", "", 200},

		{"bob", "GET", "/api/me", "", 200},
		{"bob", "GET", "/api/orders", "", 200},
		{"bob", "POST", "/api/orders", order, 201},
		{"bob", "GET", "/api/admin/stats", "", 403},
		{"bob", "GET", "/api/admin/orders", "", 403},

		{"carol", "GET", "/api/me", "", 200},
		{"carol", "GET", "/api/orders", "", 403},
		{"carol", "POST", "/api/orders", order, 403},
		{"carol", "GET", "/api/admin/stats", "", 403},
		{"carol", "GET", "/api/admin/orders", "", 403},
	}
	for _, c := range cases {
		name := c.user
		if name == "" {
			name = "anonymous"
		}
		t.Run(name+" "+c.method+" "+c.path, func(t *testing.T) {
			rec, obj := a.call(t, c.user, c.method, c.path, c.body)
			if rec.Code != c.want {
				t.Fatalf("status %d, want %d (body %s)", rec.Code, c.want, rec.Body)
			}
			switch c.want {
			case 401:
				if obj["error"] != "unauthorized" || rec.Header().Get("WWW-Authenticate") == "" {
					t.Fatalf("401 shape: %s %v", rec.Body, rec.Header())
				}
			case 403:
				want := "user"
				if strings.HasPrefix(c.path, "/api/admin") {
					want = "admin"
				}
				if obj["error"] != "forbidden" || obj["required_role"] != want {
					t.Fatalf("403 shape: %s", rec.Body)
				}
			}
		})
	}
}

func TestMeShape(t *testing.T) {
	a := newApp(t)
	_, me := a.call(t, "alice", "GET", "/api/me", "")
	for _, k := range []string{"sub", "name", "preferred_username", "email", "roles", "claims"} {
		if _, ok := me[k]; !ok {
			t.Fatalf("/api/me lacks %q: %v", k, me)
		}
	}
	if me["preferred_username"] != "alice" || me["email"] != "alice@example.com" {
		t.Fatalf("%v", me)
	}
	if roles, _ := me["roles"].([]any); len(roles) != 2 || roles[0] != "admin" || roles[1] != "user" {
		t.Fatalf("roles %v", me["roles"])
	}
	if claims, _ := me["claims"].(map[string]any); claims["iss"] != a.idp.Issuer {
		t.Fatalf("claims %v", me["claims"])
	}
}

func TestOrdersFlow(t *testing.T) {
	a := newApp(t)

	rec, created := a.call(t, "bob", "POST", "/api/orders", `{"item":" Laptop ","quantity":2}`)
	if rec.Code != 201 || created["owner"] != "bob" || created["item"] != "Laptop" || created["quantity"] != 2.0 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	for _, k := range []string{"id", "item", "quantity", "owner", "createdAt"} {
		if _, ok := created[k]; !ok {
			t.Fatalf("order lacks %q", k)
		}
	}

	var mine []map[string]any
	rec, _ = a.call(t, "bob", "GET", "/api/orders", "")
	_ = json.Unmarshal(rec.Body.Bytes(), &mine)
	if len(mine) != 2 { // 1 seeded + 1 created
		t.Fatalf("bob should see his 2 orders, got %s", rec.Body)
	}
	for _, o := range mine {
		if o["owner"] != "bob" {
			t.Fatalf("bob sees someone else's order: %v", o)
		}
	}

	rec, _ = a.call(t, "carol", "GET", "/api/orders", "")
	if rec.Code != 403 {
		t.Fatalf("carol %d", rec.Code)
	}

	var all []map[string]any
	rec, _ = a.call(t, "alice", "GET", "/api/admin/orders", "")
	_ = json.Unmarshal(rec.Body.Bytes(), &all)
	if len(all) != 4 {
		t.Fatalf("admin should see 4 orders, got %s", rec.Body)
	}

	_, stats := a.call(t, "alice", "GET", "/api/admin/stats", "")
	if stats["orders"] != 4.0 || stats["users"] != 2.0 {
		t.Fatalf("stats %v", stats)
	}
	if _, ok := stats["uptimeSeconds"]; !ok {
		t.Fatalf("stats %v", stats)
	}
}

func TestCreateOrderValidation(t *testing.T) {
	a := newApp(t)
	for _, body := range []string{``, `not json`, `{"item":"","quantity":1}`, `{"item":"x","quantity":0}`,
		`{"item":"x","quantity":1001}`, `{"item":"x","quantity":1,"extra":true}`, `{"item":"x","quantity":"1"}`} {
		rec, obj := a.call(t, "bob", "POST", "/api/orders", body)
		if rec.Code != 400 || obj["error"] != "bad_request" {
			t.Fatalf("body %q: %d %s", body, rec.Code, rec.Body)
		}
	}
}

func TestProbesAndErrors(t *testing.T) {
	a := newApp(t)
	if rec, _ := a.call(t, "", "GET", "/healthz", ""); rec.Code != 200 {
		t.Fatalf("healthz %d", rec.Code)
	}
	if rec, obj := a.call(t, "", "GET", "/readyz", ""); rec.Code != 200 || obj["status"] != "ready" {
		t.Fatalf("readyz %d %s", rec.Code, rec.Body)
	}
	a.ready = errors.New("oidc discovery pending")
	if rec, obj := a.call(t, "", "GET", "/readyz", ""); rec.Code != 503 || obj["reason"] != "oidc discovery pending" {
		t.Fatalf("readyz %d %s", rec.Code, rec.Body)
	}
	if rec, obj := a.call(t, "", "GET", "/nope", ""); rec.Code != 404 || obj["error"] != "not_found" {
		t.Fatalf("404 %d %s", rec.Code, rec.Body)
	}
	if rec, obj := a.call(t, "alice", "DELETE", "/api/orders", ""); rec.Code != 405 || obj["error"] != "method_not_allowed" {
		t.Fatalf("405 %d %s", rec.Code, rec.Body)
	}
}

func TestVerifierNotReadyGives503(t *testing.T) {
	idp := authtest.New(t)
	authn := &auth.Authenticator{Realm: "x", Log: slog.New(slog.DiscardHandler)}
	h := api.NewRouter(api.Deps{Log: slog.New(slog.DiscardHandler), Auth: authn, Orders: orders.NewSeeded(),
		Ready: func() error { return errors.New("starting") }, Started: time.Now()})
	req := httptest.NewRequest("GET", "/api/me", nil)
	req.Header.Set("Authorization", "Bearer "+idp.Token(t, "alice"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 503 {
		t.Fatalf("got %d", rec.Code)
	}
	if rec := httptest.NewRecorder(); true {
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/public", nil))
		if rec.Code != 200 {
			t.Fatalf("public route must work without a verifier, got %d", rec.Code)
		}
	}
}

func TestCORS(t *testing.T) {
	a := newApp(t)

	// Preflight from the Angular origin: answered before auth, no token needed.
	req := httptest.NewRequest("OPTIONS", "/api/orders", nil)
	req.Header.Set("Origin", "http://angular.127.0.0.1.nip.io")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	if rec.Code != 200 && rec.Code != 204 {
		t.Fatalf("preflight %d %s", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://angular.127.0.0.1.nip.io" {
		t.Fatalf("allow-origin %q", got)
	}
	if got := strings.ToLower(rec.Header().Get("Access-Control-Allow-Headers")); !strings.Contains(got, "authorization") {
		t.Fatalf("allow-headers %q", got)
	}

	// Unknown origin: no CORS headers (the browser blocks the response).
	req = httptest.NewRequest("OPTIONS", "/api/orders", nil)
	req.Header.Set("Origin", "http://evil.example")
	req.Header.Set("Access-Control-Request-Method", "GET")
	rec = httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unknown origin must not be allowed")
	}

	// Actual 401 response exposes WWW-Authenticate so the SPA can read error_description.
	req = httptest.NewRequest("GET", "/api/me", nil)
	req.Header.Set("Origin", "http://next.127.0.0.1.nip.io")
	rec = httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	if rec.Code != 401 || !strings.EqualFold(rec.Header().Get("Access-Control-Expose-Headers"), "WWW-Authenticate") {
		t.Fatalf("%d %v", rec.Code, rec.Header())
	}
}

// TestCORSEmptyOriginsFailsClosed: go-chi/cors would treat an empty allow-list
// as "*"; the router must turn it into deny-all instead.
func TestCORSEmptyOriginsFailsClosed(t *testing.T) {
	authn := &auth.Authenticator{Realm: "x", Log: slog.New(slog.DiscardHandler)}
	h := api.NewRouter(api.Deps{Log: slog.New(slog.DiscardHandler), Auth: authn, Orders: orders.NewSeeded(),
		CORSOrigins: []string{}, Ready: func() error { return nil }, Started: time.Now()})
	for _, method := range []string{"OPTIONS", "GET"} {
		req := httptest.NewRequest(method, "/api/public", nil)
		req.Header.Set("Origin", "http://evil.example")
		if method == "OPTIONS" {
			req.Header.Set("Access-Control-Request-Method", "GET")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("%s with empty CORS_ORIGINS: got Access-Control-Allow-Origin %q, want none", method, got)
		}
	}
}

func TestRealServerRoundTrip(t *testing.T) {
	a := newApp(t)
	srv := httptest.NewServer(a.h)
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/api/me", nil)
	req.Header.Set("Authorization", "Bearer "+a.idp.Token(t, "bob"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"preferred_username":"bob"`) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
}
