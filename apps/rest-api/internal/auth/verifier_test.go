package auth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth/authtest"
)

func newVerifier(t *testing.T, idp *authtest.IdP, mutate func(*auth.Config)) *auth.Verifier {
	t.Helper()
	cfg := auth.Config{Issuer: idp.Issuer, Audiences: []string{idp.Audience}}
	if mutate != nil {
		mutate(&cfg)
	}
	v, err := auth.NewVerifier(context.Background(), cfg)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return v
}

// description returns the client-safe description of a verification error.
func description(t *testing.T, err error) string {
	t.Helper()
	var e *auth.Error
	if !errors.As(err, &e) {
		t.Fatalf("expected *auth.Error, got %T: %v", err, err)
	}
	return e.Description
}

func TestVerify_ValidToken(t *testing.T) {
	idp := authtest.New(t)
	v := newVerifier(t, idp, nil)
	tok, err := v.Verify(context.Background(), idp.Token(t, "alice"))
	if err != nil {
		t.Fatal(err)
	}
	if tok.Subject != "uuid-alice" || tok.Issuer != idp.Issuer || tok.Claims["preferred_username"] != "alice" {
		t.Fatalf("unexpected token: %+v", tok)
	}
	if v.IssuerClaim != idp.Issuer || v.JWKSURI != idp.JWKSURI() {
		t.Fatalf("verifier metadata: %+v", v)
	}
}

func TestVerify_Audience(t *testing.T) {
	idp := authtest.New(t)
	v := newVerifier(t, idp, nil)
	ctx := context.Background()

	c := idp.Claims("bob")
	c["aud"] = "k8sgateway-api" // aud as a plain string (Entra, single audience)
	if _, err := v.Verify(ctx, idp.Sign(t, c)); err != nil {
		t.Fatalf("string aud: %v", err)
	}
	c["aud"] = []string{"account", "k8sgateway-api"} // aud array containing ours (Keycloak)
	if _, err := v.Verify(ctx, idp.Sign(t, c)); err != nil {
		t.Fatalf("array aud: %v", err)
	}
	c["aud"] = []string{"account", "other-api"}
	_, err := v.Verify(ctx, idp.Sign(t, c))
	if d := description(t, err); d != "audience mismatch" {
		t.Fatalf("got %q", d)
	}
	delete(c, "aud")
	if _, err := v.Verify(ctx, idp.Sign(t, c)); err == nil {
		t.Fatal("missing aud must be rejected")
	}

	// several accepted audiences (Entra v1 api://<id> and v2 <id> at the same time)
	multi := newVerifier(t, idp, func(cfg *auth.Config) { cfg.Audiences = []string{"api://k8sgateway-api", "k8sgateway-api"} })
	if _, err := multi.Verify(ctx, idp.Token(t, "bob")); err != nil {
		t.Fatal(err)
	}
}

func TestVerify_IssuerMismatch(t *testing.T) {
	idp := authtest.New(t)
	v := newVerifier(t, idp, nil)
	c := idp.Claims("alice")
	c["iss"] = idp.Issuer + "/" // even a trailing slash differs
	_, err := v.Verify(context.Background(), idp.Sign(t, c))
	d := description(t, err)
	if d != "issuer mismatch" {
		t.Fatalf("got %q (%v)", d, err)
	}
	if strings.Contains(d, idp.Issuer) {
		t.Fatal("description must not leak the expected issuer")
	}
}

func TestVerify_ExpiryWithSkew(t *testing.T) {
	idp := authtest.New(t)
	v := newVerifier(t, idp, nil)
	ctx := context.Background()

	c := idp.Claims("alice")
	c["exp"] = time.Now().Add(-30 * time.Second).Unix() // inside the 60s tolerance
	if _, err := v.Verify(ctx, idp.Sign(t, c)); err != nil {
		t.Fatalf("30s past exp should pass: %v", err)
	}
	c["exp"] = time.Now().Add(-120 * time.Second).Unix()
	_, err := v.Verify(ctx, idp.Sign(t, c))
	if d := description(t, err); d != "token expired" {
		t.Fatalf("got %q", d)
	}
}

func TestVerify_NotBeforeWithSkew(t *testing.T) {
	idp := authtest.New(t)
	v := newVerifier(t, idp, nil)
	ctx := context.Background()

	c := idp.Claims("alice")
	c["nbf"] = time.Now().Add(30 * time.Second).Unix()
	if _, err := v.Verify(ctx, idp.Sign(t, c)); err != nil {
		t.Fatalf("nbf 30s ahead should pass: %v", err)
	}
	c["nbf"] = time.Now().Add(120 * time.Second).Unix()
	_, err := v.Verify(ctx, idp.Sign(t, c))
	if d := description(t, err); d != "token not yet valid" {
		t.Fatalf("got %q", d)
	}
}

func TestVerify_RejectsNoneAndHS256(t *testing.T) {
	idp := authtest.New(t)
	v := newVerifier(t, idp, nil)
	ctx := context.Background()
	c := idp.Claims("alice")

	if _, err := v.Verify(ctx, authtest.Unsigned(c)); err == nil {
		t.Fatal("alg=none must be rejected")
	}
	// Algorithm confusion: HS256 with the RSA public key material as the secret.
	if _, err := v.Verify(ctx, idp.HS256(c, []byte("whatever"))); err == nil {
		t.Fatal("HS256 must be rejected")
	}
	if _, err := v.Verify(ctx, "not.a.jwt"); err == nil {
		t.Fatal("garbage must be rejected")
	}
	_, err := v.Verify(ctx, "")
	if description(t, err) == "" {
		t.Fatal("empty description")
	}
}

func TestVerify_UnknownKey(t *testing.T) {
	idp := authtest.New(t)
	v := newVerifier(t, idp, nil)
	rogue, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	_, err = v.Verify(context.Background(), authtest.SignRS256(t, rogue, "rogue-kid", idp.Claims("alice")))
	if d := description(t, err); d != "invalid signature" {
		t.Fatalf("got %q (%v)", d, err)
	}
}

func TestVerify_KeyRotationAndCaching(t *testing.T) {
	idp := authtest.New(t)
	v := newVerifier(t, idp, nil) // NewVerifier probes the JWKS once
	ctx := context.Background()

	old := idp.Token(t, "alice")
	for range 5 {
		if _, err := v.Verify(ctx, old); err != nil {
			t.Fatal(err)
		}
	}
	if n := idp.JWKSFetches.Load(); n != 2 { // 1 probe + 1 lazy fetch, then cached
		t.Fatalf("expected 2 JWKS fetches, got %d", n)
	}

	idp.Rotate(t) // IdP publishes a new key under a new kid
	if _, err := v.Verify(ctx, idp.Token(t, "alice")); err != nil {
		t.Fatalf("token with new kid should trigger a re-fetch: %v", err)
	}
	if n := idp.JWKSFetches.Load(); n != 3 {
		t.Fatalf("expected 3 JWKS fetches after rotation, got %d", n)
	}
	if _, err := v.Verify(ctx, old); err == nil {
		t.Fatal("token signed with the retired key must now fail")
	}
}

func TestNewVerifier_IssuerClaimOverride(t *testing.T) {
	idp := authtest.New(t)
	idp.IssuerClaim = "https://identity.oraclecloud.com/" // discovery doc advertises this, URL differs

	// Without OIDC_ISSUER_CLAIM go-oidc refuses the mismatch - by design.
	if _, err := auth.NewVerifier(context.Background(), auth.Config{Issuer: idp.Issuer, Audiences: []string{idp.Audience}}); err == nil {
		t.Fatal("expected issuer mismatch error from discovery")
	}
	v := newVerifier(t, idp, func(cfg *auth.Config) { cfg.IssuerClaim = "https://identity.oraclecloud.com/" })
	if _, err := v.Verify(context.Background(), idp.Token(t, "alice")); err != nil {
		t.Fatal(err)
	}
	c := idp.Claims("alice")
	c["iss"] = idp.Issuer // tokens carrying the discovery URL are NOT accepted
	if _, err := v.Verify(context.Background(), idp.Sign(t, c)); err == nil {
		t.Fatal("iss must equal OIDC_ISSUER_CLAIM exactly")
	}
}

func TestNewVerifier_JWKSOverride(t *testing.T) {
	idp := authtest.New(t)
	idp.IssuerClaim = "http://idp.127.0.0.1.nip.io" // public issuer that this test cannot resolve
	v, err := auth.NewVerifier(context.Background(), auth.Config{
		Issuer:    "http://idp.127.0.0.1.nip.io", // never contacted: no discovery when JWKSURI is set
		JWKSURI:   idp.JWKSURI(),
		Audiences: []string{idp.Audience},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Verify(context.Background(), idp.Token(t, "alice")); err != nil {
		t.Fatal(err)
	}
}

func TestNewVerifier_Errors(t *testing.T) {
	ctx := context.Background()
	if _, err := auth.NewVerifier(ctx, auth.Config{}); err == nil {
		t.Fatal("missing issuer/audience must fail")
	}
	down := httptest.NewServer(nil)
	down.Close()
	if _, err := auth.NewVerifier(ctx, auth.Config{Issuer: down.URL, Audiences: []string{"x"}}); err == nil {
		t.Fatal("unreachable IdP must fail (so the caller can retry)")
	}
	// JWKS reachable but empty -> not ready.
	empty := httptest.NewServer(httptestHandler(`{"keys":[]}`))
	defer empty.Close()
	if _, err := auth.NewVerifier(ctx, auth.Config{Issuer: "http://x", JWKSURI: empty.URL, Audiences: []string{"x"}}); err == nil {
		t.Fatal("JWKS without keys must fail")
	}
}
