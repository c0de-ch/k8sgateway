// Command api is the Go REST service of the k8sgateway tutorial. It never talks
// to the IdP for authentication - it only fetches the IdP's public keys and
// validates the JWT access tokens that clients present.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/api"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/orders"
)

// config is read from environment variables only (12-factor); see README for the table.
type config struct {
	Port        string
	Issuer      string
	IssuerClaim string
	JWKSURI     string
	Audiences   []string
	RolesClaim  string
	RoleUser    string
	RoleAdmin   string
	CORSOrigins []string
	LogLevel    slog.Level
}

func loadConfig() config {
	c := config{
		Port:        env("PORT", "8080"),
		Issuer:      env("OIDC_ISSUER", "http://idp.127.0.0.1.nip.io"),
		IssuerClaim: os.Getenv("OIDC_ISSUER_CLAIM"), // empty = same as OIDC_ISSUER
		JWKSURI:     os.Getenv("OIDC_JWKS_URI"),     // empty = from discovery
		Audiences:   splitList(env("OIDC_AUDIENCE", "k8sgateway-api")),
		RolesClaim:  env("ROLES_CLAIM", "roles"),
		RoleUser:    env("ROLE_USER", "user"),
		RoleAdmin:   env("ROLE_ADMIN", "admin"),
		CORSOrigins: splitList(env("CORS_ORIGINS", "http://angular.127.0.0.1.nip.io,http://next.127.0.0.1.nip.io")),
		LogLevel:    slog.LevelInfo,
	}
	if strings.EqualFold(os.Getenv("LOG_LEVEL"), "debug") {
		c.LogLevel = slog.LevelDebug
	}
	return c
}

func main() {
	cfg := loadConfig()
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)
	if len(cfg.CORSOrigins) == 0 {
		// The router turns an empty list into deny-all (see api.NewRouter); say so
		// at startup instead of letting browsers fail silently.
		log.Warn("CORS_ORIGINS is empty: every cross-origin browser request will be refused")
	}

	// ctx ends on SIGTERM/SIGINT: it aborts an in-flight discovery and starts the shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	authn := &auth.Authenticator{
		Realm:      "k8sgateway-api",
		RolesClaim: cfg.RolesClaim,
		Roles:      auth.RoleNames{User: cfg.RoleUser, Admin: cfg.RoleAdmin},
		Log:        log,
	}

	// Readiness = verifier initialised and not shutting down. The last discovery
	// error is shown in /readyz so a wrong OIDC_ISSUER is visible in kubectl.
	var startupErr atomic.Pointer[string]
	var shuttingDown atomic.Bool
	ready := func() error {
		if shuttingDown.Load() {
			return errors.New("shutting down")
		}
		if !authn.Ready() {
			msg := "oidc discovery pending"
			if e := startupErr.Load(); e != nil {
				msg += ": " + *e
			}
			return errors.New(msg)
		}
		return nil
	}

	handler := api.NewRouter(api.Deps{
		Log: log, Auth: authn, Orders: orders.NewSeeded(),
		CORSOrigins: cfg.CORSOrigins, Ready: ready, Started: time.Now(),
	})

	// Discovery runs in the background with backoff: on kind the IdP (Keycloak
	// especially) is often still starting when this pod comes up, and a crash
	// loop would only hide the real problem. /readyz stays 503 meanwhile.
	go func() {
		ocfg := auth.Config{Issuer: cfg.Issuer, IssuerClaim: cfg.IssuerClaim, JWKSURI: cfg.JWKSURI, Audiences: cfg.Audiences}
		for attempt, backoff := 1, time.Second; ; attempt, backoff = attempt+1, min(backoff*2, 15*time.Second) {
			v, err := auth.NewVerifier(ctx, ocfg)
			if err == nil {
				authn.SetVerifier(v)
				log.Info("oidc verifier ready", "issuer", cfg.Issuer, "issuer_claim", v.IssuerClaim,
					"jwks_uri", v.JWKSURI, "audience", cfg.Audiences, "roles_claim", cfg.RolesClaim, "attempt", attempt)
				return
			}
			if ctx.Err() != nil {
				return // SIGTERM aborted the in-flight discovery: a shutdown, not a failure
			}
			msg := err.Error()
			startupErr.Store(&msg)
			log.Warn("oidc init failed, retrying", "err", msg, "attempt", attempt, "retry_in", backoff.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
		}
	}()

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      35 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		log.Info("listening", "addr", srv.Addr, "log_level", cfg.LogLevel.String())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server failed", "err", err.Error())
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	stop()
	log.Info("shutdown: draining")
	shuttingDown.Store(true) // /readyz -> 503 so the endpoint is withdrawn from the Service
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		time.Sleep(3 * time.Second) // give EndpointSlices / Envoy time to stop routing to us
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "err", err.Error())
		os.Exit(1)
	}
	log.Info("shutdown: complete")
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// splitList parses "a, b,c" into ["a","b","c"], dropping empty entries.
func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
