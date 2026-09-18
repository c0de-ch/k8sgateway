package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// Config mirrors the OIDC_* environment variables of the contract.
type Config struct {
	Issuer      string        // OIDC_ISSUER: base URL, discovery = Issuer + /.well-known/openid-configuration
	IssuerClaim string        // OIDC_ISSUER_CLAIM: exact "iss" tokens carry; defaults to Issuer
	JWKSURI     string        // OIDC_JWKS_URI: optional; when set, discovery is skipped entirely
	Audiences   []string      // OIDC_AUDIENCE: at least one of these must be in "aud"
	ClockSkew   time.Duration // tolerance for exp/nbf; default 60s
	HTTPClient  *http.Client  // used for discovery and JWKS; default has a 10s timeout
	Now         func() time.Time
}

// AllowedAlgs is the explicit signature algorithm allow-list. Asymmetric only:
// with a symmetric alg (HS*) the public JWKS material would double as the
// signing key, and "none" means no signature at all - go-oidc refuses both.
var AllowedAlgs = []string{oidc.RS256, oidc.RS384, oidc.RS512, oidc.PS256, oidc.ES256}

// Token is a successfully validated access token.
type Token struct {
	Subject  string
	Issuer   string
	Audience []string
	Expiry   time.Time
	Claims   map[string]any // all payload claims, for /api/me and role extraction
}

// Error is a verification failure. Description is short and free of
// configuration values, so it can be returned to clients as error_description;
// Cause holds the full reason for the server log.
type Error struct {
	Description string
	Cause       error
}

func (e *Error) Error() string { return e.Description + ": " + e.Cause.Error() }
func (e *Error) Unwrap() error { return e.Cause }

// Verifier validates bearer tokens. Build ONE per process (NewVerifier) and
// share it: the JWKS behind it is cached in memory and only re-fetched when a
// token carries an unknown "kid". go-oidc keeps no negative cache and no rate
// limit for such misses, so every rejected token with a never-seen kid costs
// one GET on the IdP's jwks_uri (concurrent misses share a single request).
// Validating tokens at the gateway first (deploy/gateway-policies) or rate
// limiting 401s keeps a flood of garbage tokens away from the IdP.
type Verifier struct {
	idt       *oidc.IDTokenVerifier
	audiences []string
	skew      time.Duration
	now       func() time.Time

	IssuerClaim string // what "iss" must equal
	JWKSURI     string // where keys come from (discovered or overridden)
}

// NewVerifier performs discovery (unless JWKSURI is set), checks that the JWKS
// endpoint answers, and returns the shared verifier. It fails fast on network
// errors so the caller can retry with backoff while the IdP is still starting.
func NewVerifier(ctx context.Context, cfg Config) (*Verifier, error) {
	if cfg.Issuer == "" || len(cfg.Audiences) == 0 {
		return nil, errors.New("OIDC_ISSUER and OIDC_AUDIENCE are required")
	}
	issuerClaim := cfg.IssuerClaim
	if issuerClaim == "" {
		issuerClaim = cfg.Issuer
	}
	skew := cfg.ClockSkew
	if skew == 0 {
		skew = 60 * time.Second
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	ctx = oidc.ClientContext(ctx, client) // go-oidc takes its HTTP client from the context

	oc := &oidc.Config{
		SupportedSigningAlgs: AllowedAlgs,
		// We check "aud" ourselves (see Verify) so a list of accepted audiences works.
		SkipClientIDCheck: true,
		// go-oidc rejects exp without leeway; shifting "now" back by the skew makes a
		// token valid until exp + skew (nbf is re-checked with the same skew in Verify).
		Now: func() time.Time { return now().Add(-skew) },
	}

	var idt *oidc.IDTokenVerifier
	jwks := cfg.JWKSURI
	if jwks != "" {
		// Keys from a known URL (e.g. a cluster-internal Service): no discovery round trip.
		idt = oidc.NewVerifier(issuerClaim, oidc.NewRemoteKeySet(ctx, jwks), oc)
	} else {
		dctx := ctx
		if issuerClaim != cfg.Issuer {
			// Oracle IAM Identity Domains advertises issuer "https://identity.oraclecloud.com/"
			// while the metadata lives under the tenant URL; go-oidc would refuse the
			// mismatch. This opt-out fetches metadata from cfg.Issuer but still requires
			// "iss" == issuerClaim on every token - review the value carefully.
			dctx = oidc.InsecureIssuerURLContext(ctx, issuerClaim)
		}
		provider, err := oidc.NewProvider(dctx, cfg.Issuer)
		if err != nil {
			return nil, fmt.Errorf("oidc discovery via %s: %w", cfg.Issuer, err)
		}
		var meta struct {
			JWKSURI string `json:"jwks_uri"`
		}
		if err := provider.Claims(&meta); err != nil || meta.JWKSURI == "" {
			return nil, fmt.Errorf("oidc discovery via %s: no jwks_uri in metadata", cfg.Issuer)
		}
		jwks = meta.JWKSURI
		idt = provider.Verifier(oc) // shares the provider's single RemoteKeySet
	}

	if err := probeJWKS(ctx, client, jwks); err != nil {
		return nil, err
	}
	return &Verifier{
		idt: idt, audiences: cfg.Audiences, skew: skew, now: now,
		IssuerClaim: issuerClaim, JWKSURI: jwks,
	}, nil
}

// probeJWKS fetches the key set once so readiness means "the IdP is reachable
// and publishes keys" - a misconfigured or not-yet-started IdP shows up in
// /readyz instead of as 401s later.
func probeJWKS(ctx context.Context, client *http.Client, uri string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, uri, nil)
	if err != nil {
		return fmt.Errorf("jwks %s: %w", uri, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("jwks %s: %w", uri, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks %s: HTTP %d", uri, resp.StatusCode)
	}
	var doc struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(body, &doc); err != nil || len(doc.Keys) == 0 {
		return fmt.Errorf("jwks %s: response has no keys", uri)
	}
	return nil
}

// Verify validates a raw JWT: signature against the JWKS with an allow-listed
// alg, iss == IssuerClaim, exp/nbf with clock skew, and aud contains one of the
// configured audiences (aud may be a string or an array).
func (v *Verifier) Verify(ctx context.Context, raw string) (*Token, error) {
	t, err := v.idt.Verify(ctx, raw)
	if err != nil {
		return nil, classify(err)
	}
	if !containsAny(t.Audience, v.audiences) {
		return nil, &Error{Description: "audience mismatch",
			Cause: fmt.Errorf("aud %q does not contain %q", t.Audience, v.audiences)}
	}
	var claims map[string]any
	if err := t.Claims(&claims); err != nil {
		return nil, &Error{Description: "malformed claims", Cause: err}
	}
	// go-oidc tolerates nbf up to 5 minutes in the future; the contract says 60s.
	if nbf, ok := claims["nbf"].(float64); ok {
		if notBefore := time.Unix(int64(nbf), 0); notBefore.After(v.now().Add(v.skew)) {
			return nil, &Error{Description: "token not yet valid",
				Cause: fmt.Errorf("nbf %s is in the future", notBefore.UTC().Format(time.RFC3339))}
		}
	}
	return &Token{Subject: t.Subject, Issuer: t.Issuer, Audience: t.Audience, Expiry: t.Expiry, Claims: claims}, nil
}

// classify maps go-oidc errors to a client-safe description. The go-oidc text
// contains the expected issuer and audience, so it is only ever logged.
func classify(err error) *Error {
	var expired *oidc.TokenExpiredError
	msg := err.Error()
	switch {
	case errors.As(err, &expired):
		return &Error{Description: "token expired", Cause: err}
	case strings.Contains(msg, "different provider"):
		return &Error{Description: "issuer mismatch", Cause: err}
	case strings.Contains(msg, "malformed"), strings.Contains(msg, "not signed"):
		return &Error{Description: "malformed token or unsupported algorithm", Cause: err}
	case strings.Contains(msg, "signature"), strings.Contains(msg, "fetching keys"):
		return &Error{Description: "invalid signature", Cause: err}
	case strings.Contains(msg, "nbf"):
		return &Error{Description: "token not yet valid", Cause: err}
	}
	return &Error{Description: "token verification failed", Cause: err}
}

func containsAny(have, want []string) bool {
	for _, w := range want {
		if contains(have, w) {
			return true
		}
	}
	return false
}
