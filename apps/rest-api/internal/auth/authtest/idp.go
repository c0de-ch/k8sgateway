// Package authtest is an in-memory OpenID provider for unit tests: one RSA key,
// a JWKS and discovery endpoint on httptest, and a hand-rolled RS256 minter.
// It is not compiled into the API binary.
package authtest

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Users mirrors the demo users of the tutorial (roles as the IdP emits them).
var Users = map[string][]string{
	"alice": {"admin", "user"},
	"bob":   {"user"},
	"carol": {},
}

// IdP is a fake identity provider.
type IdP struct {
	Server      *httptest.Server
	Issuer      string // discovery base URL (the httptest URL)
	IssuerClaim string // value written into "iss" and the discovery document; defaults to Issuer
	Audience    string
	JWKSFetches atomic.Int32 // how often /jwks was requested

	mu  sync.Mutex
	key *rsa.PrivateKey
	kid string
}

// New starts the fake IdP; it is closed when the test ends.
func New(t testing.TB) *IdP {
	t.Helper()
	p := &IdP{Audience: "k8sgateway-api"}
	p.Rotate(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"issuer":                                p.IssuerClaim,
			"jwks_uri":                              p.JWKSURI(),
			"authorization_endpoint":                p.Issuer + "/authorize",
			"token_endpoint":                        p.Issuer + "/token",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("GET /jwks", func(w http.ResponseWriter, r *http.Request) {
		p.JWKSFetches.Add(1)
		p.mu.Lock()
		pub, kid := p.key.PublicKey, p.kid
		p.mu.Unlock()
		writeJSON(w, map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid,
			"n": b64(pub.N.Bytes()), "e": b64(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	})
	p.Server = httptest.NewServer(mux)
	p.Issuer, p.IssuerClaim = p.Server.URL, p.Server.URL
	t.Cleanup(p.Server.Close)
	return p
}

// JWKSURI is the key set URL.
func (p *IdP) JWKSURI() string { return p.Issuer + "/jwks" }

// Rotate replaces the signing key and kid, as a real IdP does periodically.
func (p *IdP) Rotate(t testing.TB) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	p.key, p.kid = key, "kid-"+b64(key.PublicKey.N.Bytes()[:6])
	p.mu.Unlock()
}

// Claims returns a valid access-token payload for a demo user (5 minutes lifetime).
// Tests mutate the map before signing to produce negative cases.
func (p *IdP) Claims(username string) map[string]any {
	now := time.Now()
	roles := Users[username]
	if roles == nil {
		roles = []string{}
	}
	return map[string]any{
		"iss": p.IssuerClaim, "sub": "uuid-" + username, "aud": []string{p.Audience},
		"exp": now.Add(5 * time.Minute).Unix(), "iat": now.Unix(), "nbf": now.Unix(),
		"preferred_username": username, "name": strings.ToUpper(username[:1]) + username[1:] + " Demo",
		"email": username + "@example.com", "roles": roles,
	}
}

// Token mints a valid RS256 token for a demo user.
func (p *IdP) Token(t testing.TB, username string) string {
	t.Helper()
	return p.Sign(t, p.Claims(username))
}

// Sign mints an RS256 JWT with the current key and kid.
func (p *IdP) Sign(t testing.TB, claims map[string]any) string {
	t.Helper()
	p.mu.Lock()
	key, kid := p.key, p.kid
	p.mu.Unlock()
	return SignRS256(t, key, kid, claims)
}

// SignRS256 mints a JWT with an arbitrary RSA key (e.g. one the IdP never published).
func SignRS256(t testing.TB, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	signingInput := encodeHeader(map[string]any{"alg": "RS256", "typ": "JWT", "kid": kid}) + "." + encodeJSON(claims)
	sum := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return signingInput + "." + b64(sig)
}

// Unsigned mints an "alg":"none" token - must always be rejected.
func Unsigned(claims map[string]any) string {
	return encodeHeader(map[string]any{"alg": "none", "typ": "JWT"}) + "." + encodeJSON(claims) + "."
}

// HS256 mints a token symmetrically signed with the IdP's kid - must be rejected
// even though the kid matches (algorithm confusion attack).
func (p *IdP) HS256(claims map[string]any, secret []byte) string {
	p.mu.Lock()
	kid := p.kid
	p.mu.Unlock()
	signingInput := encodeHeader(map[string]any{"alg": "HS256", "typ": "JWT", "kid": kid}) + "." + encodeJSON(claims)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signingInput))
	return signingInput + "." + b64(mac.Sum(nil))
}

func encodeHeader(h map[string]any) string { return encodeJSON(h) }

func encodeJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b64(b)
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
