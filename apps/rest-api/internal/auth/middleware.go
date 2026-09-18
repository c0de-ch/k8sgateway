package auth

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/httpx"
)

type principalKey struct{}

// Principal is what handlers see after authentication.
type Principal struct {
	Subject  string
	Roles    []string       // application roles: "admin", "user"
	RawRoles []string       // values found at ROLES_CLAIM before mapping
	Claims   map[string]any // full access-token payload
}

// HasRole reports whether the principal holds an application role.
func (p *Principal) HasRole(role string) bool { return contains(p.Roles, role) }

// Username returns the human-friendly identity used as order owner:
// preferred_username when the IdP sends one, otherwise the stable sub.
func (p *Principal) Username() string {
	if s, _ := p.Claims["preferred_username"].(string); s != "" {
		return s
	}
	return p.Subject
}

// FromContext returns the Principal stored by Authenticator.Middleware.
func FromContext(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(*Principal)
	return p, ok
}

// Authenticator is the bearer-token middleware. The Verifier is attached later
// (SetVerifier) because discovery may still be retrying when the server starts;
// until then protected routes answer 503.
type Authenticator struct {
	Realm      string
	RolesClaim string    // ROLES_CLAIM dotted path
	Roles      RoleNames // ROLE_USER / ROLE_ADMIN values
	Log        *slog.Logger

	verifier atomic.Pointer[Verifier]
}

// SetVerifier makes the middleware operational. Safe to call from another goroutine.
func (a *Authenticator) SetVerifier(v *Verifier) { a.verifier.Store(v) }

// Ready reports whether a verifier is attached.
func (a *Authenticator) Ready() bool { return a.verifier.Load() != nil }

// Middleware: Authorization: Bearer <jwt> -> Verify -> Principal in context.
// Failures answer 401 with a WWW-Authenticate challenge (RFC 6750 section 3).
func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v := a.verifier.Load()
		if v == nil {
			httpx.WriteError(w, http.StatusServiceUnavailable, "unavailable", "token verifier not initialised yet (IdP discovery pending)")
			return
		}
		raw, ok := bearerToken(r)
		if !ok {
			a.unauthorized(w, "", "missing bearer token") // no error code: no credentials were sent
			return
		}
		tok, err := v.Verify(r.Context(), raw)
		if err != nil {
			desc := "token verification failed"
			if e, ok := err.(*Error); ok {
				desc = e.Description
			}
			a.Log.Warn("token rejected", "reason", err.Error(), "path", r.URL.Path) // never the token itself
			a.unauthorized(w, "invalid_token", desc)
			return
		}
		rawRoles := RolesFromClaims(tok.Claims, a.RolesClaim)
		p := &Principal{Subject: tok.Subject, Roles: a.Roles.AppRoles(rawRoles), RawRoles: rawRoles, Claims: tok.Claims}
		httpx.AddLogAttrs(r.Context(), slog.String("sub", p.Subject), slog.Any("roles", p.Roles))
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
	})
}

// RequireRole answers 403 {"error":"forbidden","required_role":role} unless the
// authenticated principal holds the application role.
func RequireRole(role string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := FromContext(r.Context())
			if !ok { // misuse: RequireRole without Middleware in front
				httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "not authenticated")
				return
			}
			if !p.HasRole(role) {
				w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer error="insufficient_scope", scope=%q`, role))
				httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden", "required_role": role})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (a *Authenticator) unauthorized(w http.ResponseWriter, code, desc string) {
	challenge := fmt.Sprintf(`Bearer realm=%q`, a.Realm)
	if code != "" {
		challenge += fmt.Sprintf(`, error=%q, error_description=%q`, code, desc)
	}
	w.Header().Set("WWW-Authenticate", challenge)
	httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", desc)
}

// bearerToken extracts the token from "Authorization: Bearer <token>" (scheme is case-insensitive).
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		if t := strings.TrimSpace(h[len(prefix):]); t != "" {
			return t, true
		}
	}
	return "", false
}
