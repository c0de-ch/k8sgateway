// Package api wires the chi router: CORS first, then probes, then the public
// and token-protected routes. Kept separate from main so tests can build the
// full application against a fake IdP.
package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/httpx"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/orders"
)

// Deps is everything the router needs.
type Deps struct {
	Log         *slog.Logger
	Auth        *auth.Authenticator
	Orders      *orders.Store
	CORSOrigins []string
	// Ready returns nil when the pod may receive traffic, otherwise the reason
	// (discovery pending, shutting down). Shown in the /readyz body.
	Ready func() error
	// Started is used for uptime in /api/admin/stats.
	Started time.Time
}

// NewRouter builds the HTTP handler.
func NewRouter(d Deps) http.Handler {
	h := &handlers{d: d}
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(httpx.RequestLogger(d.Log))
	r.Use(httpx.Recoverer(d.Log))
	r.Use(middleware.Timeout(30 * time.Second))

	// CORS must be top-level and run BEFORE authentication: a browser preflight
	// (OPTIONS) carries no Authorization header and would otherwise get a 401.
	corsOpts := cors.Options{
		AllowedOrigins:   d.CORSOrigins,
		AllowedMethods:   []string{http.MethodGet, http.MethodPost, http.MethodOptions},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"WWW-Authenticate"}, // lets the SPA read error_description on 401
		AllowCredentials: false,                        // bearer tokens, not cookies
		MaxAge:           300,
	}
	// go-chi/cors treats an EMPTY AllowedOrigins exactly like "*" (allow every
	// origin). A misconfigured CORS_ORIGINS must fail closed instead, so an empty
	// list becomes "deny all cross-origin requests".
	if len(d.CORSOrigins) == 0 {
		corsOpts.AllowOriginFunc = func(*http.Request, string) bool { return false }
	}
	r.Use(cors.Handler(corsOpts))

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteError(w, http.StatusNotFound, "not_found", "no such route")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
	})

	r.Get("/healthz", h.healthz)
	r.Get("/readyz", h.readyz)

	r.Route("/api", func(r chi.Router) {
		r.Get("/public", h.public)

		r.Group(func(r chi.Router) {
			r.Use(d.Auth.Middleware) // everything below needs a valid access token
			r.Get("/me", h.me)
			r.With(auth.RequireRole(auth.RoleUser)).Get("/orders", h.listOrders)
			r.With(auth.RequireRole(auth.RoleUser)).Post("/orders", h.createOrder)
			r.Route("/admin", func(r chi.Router) {
				r.Use(auth.RequireRole(auth.RoleAdmin))
				r.Get("/stats", h.stats)
				r.Get("/orders", h.allOrders)
			})
		})
	})
	return r
}
