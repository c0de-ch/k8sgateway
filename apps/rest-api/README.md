# rest-api (Go)

A small REST API that is protected by JWT access tokens issued by an external
OpenID Connect identity provider. The API never sees a password and never
talks to the IdP for authentication - it only fetches the IdP's **public keys**
(JWKS) and validates the tokens that clients present in `Authorization: Bearer`.

The same binary works with the mock IdP, Keycloak, Microsoft Entra ID and Oracle
IAM Identity Domains; only environment variables change.

## Endpoints

| Method | Path                | Auth        | Role    | Returns |
|--------|---------------------|-------------|---------|---------|
| GET    | `/healthz`          | none        | -       | `{"status":"ok"}` (liveness) |
| GET    | `/readyz`           | none        | -       | `200 {"status":"ready"}` once the IdP metadata + JWKS were fetched, else `503 {"status":"not_ready","reason":"..."}` |
| GET    | `/api/public`       | none        | -       | a greeting, to show that the route is reachable without a token |
| GET    | `/api/me`           | valid token | -       | `{sub, name, preferred_username, email, roles[], claims{}}` |
| GET    | `/api/orders`       | valid token | `user`  | the caller's own orders `[{id, item, quantity, owner, createdAt}]` |
| POST   | `/api/orders`       | valid token | `user`  | `201` + the created order; body `{"item": "...", "quantity": 1}` |
| GET    | `/api/admin/stats`  | valid token | `admin` | `{orders, users, uptimeSeconds}` |
| GET    | `/api/admin/orders` | valid token | `admin` | all orders of all users |

Orders live in memory (three demo orders seeded for `alice` and `bob`); the
owner is the token's `preferred_username`, or `sub` when the IdP does not send one.

Error shapes (never a stack trace):

| Status | Body | Header |
|--------|------|--------|
| 401 | `{"error":"unauthorized","error_description":"token expired"}` | `WWW-Authenticate: Bearer realm="k8sgateway-api", error="invalid_token", error_description="token expired"` |
| 403 | `{"error":"forbidden","required_role":"admin"}` | `WWW-Authenticate: Bearer error="insufficient_scope", scope="admin"` |
| 400 | `{"error":"bad_request","error_description":"quantity must be between 1 and 1000"}` | |
| 503 | `{"error":"unavailable","error_description":"token verifier not initialised yet (IdP discovery pending)"}` | |

`error_description` values are deliberately generic (`token expired`,
`issuer mismatch`, `audience mismatch`, `invalid signature`, `token not yet valid`,
`malformed token or unsupported algorithm`). The full reason - which contains
the expected issuer and audience - is only written to the server log.

## Configuration (environment variables)

| Variable            | Default | Meaning |
|---------------------|---------|---------|
| `PORT`              | `8080` | listen port |
| `OIDC_ISSUER`       | `http://idp.127.0.0.1.nip.io` | discovery base: `${OIDC_ISSUER}/.well-known/openid-configuration` |
| `OIDC_ISSUER_CLAIM` | = `OIDC_ISSUER` | exact `iss` value tokens carry, when it differs from the discovery URL (Oracle: `https://identity.oraclecloud.com/`) |
| `OIDC_JWKS_URI`     | from discovery | key-set URL override; when set, discovery is skipped entirely (e.g. a cluster-internal Service URL) |
| `OIDC_AUDIENCE`     | `k8sgateway-api` | value that must be present in `aud`; a comma-separated list accepts any of them (Entra v1 `api://<id>` and v2 `<id>`) |
| `ROLES_CLAIM`       | `roles` | dotted path to the roles claim: `roles` (mock/Entra), `realm_access.roles` (Keycloak), `groups` (Oracle), `scp` (space-separated strings work too) |
| `ROLE_USER`         | `user` | IdP value that grants the application role `user` |
| `ROLE_ADMIN`        | `admin` | IdP value that grants the application role `admin` (for Entra groups this is a GUID) |
| `CORS_ORIGINS`      | `http://angular.127.0.0.1.nip.io,http://next.127.0.0.1.nip.io` | allowed browser origins (`Authorization` header allowed, `WWW-Authenticate` exposed); an empty list fails closed and denies every cross-origin request |
| `LOG_LEVEL`         | `info` | `info` or `debug` (debug also logs probe requests) |

Per-IdP examples:

```bash
# mock IdP (generic flavor)
OIDC_ISSUER=http://idp.127.0.0.1.nip.io            ROLES_CLAIM=roles
# Keycloak realm "k8sgateway" (audience via the k8sgateway-api client scope)
OIDC_ISSUER=http://keycloak.127.0.0.1.nip.io/realms/k8sgateway  ROLES_CLAIM=realm_access.roles
# Microsoft Entra ID (single tenant, v2 tokens; audience = API app client id)
OIDC_ISSUER=https://login.microsoftonline.com/<TENANT_ID>/v2.0  OIDC_AUDIENCE=<API_CLIENT_ID>  ROLES_CLAIM=roles
# Oracle IAM Identity Domains (issuer claim differs from the domain URL)
OIDC_ISSUER=https://idcs-<GUID>.identity.oraclecloud.com  OIDC_ISSUER_CLAIM=https://identity.oraclecloud.com/ \
OIDC_JWKS_URI=https://idcs-<GUID>.identity.oraclecloud.com/admin/v1/SigningCert/jwk  OIDC_AUDIENCE=<PRIMARY_AUDIENCE>  ROLES_CLAIM=groups
```

## How token validation works

1. The request must carry `Authorization: Bearer <jwt>`; anything else is `401` with a bare `WWW-Authenticate: Bearer realm="k8sgateway-api"` challenge (RFC 6750 section 3.1: no `error` code when no credentials were sent - frontends read `error_description` from the JSON body in that case).
2. At startup the API fetches `${OIDC_ISSUER}/.well-known/openid-configuration` (retrying with backoff, `/readyz` stays 503 meanwhile) and learns the `jwks_uri` - unless `OIDC_JWKS_URI` is set, in which case no discovery happens.
3. The JWT header's `kid` selects a public key from the JWKS; keys are cached in memory and re-fetched only when an unknown `kid` shows up (key rotation). There is no negative cache: every rejected token with a never-seen `kid` costs one GET on the IdP's `jwks_uri`, so in front of the internet validate at the gateway too (`deploy/gateway-policies`) or rate-limit 401s.
4. Only asymmetric algorithms are accepted: `RS256 RS384 RS512 PS256 ES256`. `HS*` and `none` are rejected before the signature is even looked at (algorithm-confusion protection).
5. `iss` must equal `OIDC_ISSUER_CLAIM` (defaults to `OIDC_ISSUER`) byte for byte - a trailing slash difference is a mismatch.
6. `aud` (a string or an array) must contain one of the `OIDC_AUDIENCE` values - a token minted for another API is refused even if the same IdP signed it.
7. `exp` and `nbf` are enforced with 60 seconds of clock tolerance.
8. Only now are the claims trusted: `ROLES_CLAIM` is read via its dotted path; the token holds application role `user`/`admin` if the list contains `ROLE_USER`/`ROLE_ADMIN`. A missing claim means "authenticated, no roles" (that is `carol`).
9. Handlers receive a `Principal` from the request context; `RequireRole("admin")` answers `403 {"error":"forbidden","required_role":"admin"}`.
10. One JSON log line per request carries `sub` and `roles` - never the token.

The implementation is `internal/auth/verifier.go` (steps 2-7 on top of
`github.com/coreos/go-oidc/v3`) and `internal/auth/middleware.go` (steps 1, 8, 9).

## Try it

Inside the tutorial cluster (`make up`), the API is reachable at
`http://api.127.0.0.1.nip.io` and a token comes from the IdP with the `cli`
client (password grant is enabled for the demo users only):

```bash
# mock IdP or Keycloak: alice = admin+user, bob = user, carol = no roles
TOKEN=$(make -s token USER=alice)                       # or:
TOKEN=$(curl -s -X POST http://idp.127.0.0.1.nip.io/token \
  -d grant_type=password -d client_id=cli -d username=alice -d password=alice \
  -d scope=openid | jq -r .access_token)

curl -s http://api.127.0.0.1.nip.io/api/public | jq
curl -s -H "Authorization: Bearer $TOKEN" http://api.127.0.0.1.nip.io/api/me | jq
curl -s -H "Authorization: Bearer $TOKEN" http://api.127.0.0.1.nip.io/api/orders | jq
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"item":"Docking station","quantity":1}' http://api.127.0.0.1.nip.io/api/orders | jq
curl -s -H "Authorization: Bearer $TOKEN" http://api.127.0.0.1.nip.io/api/admin/stats | jq

# what the failures look like
curl -si http://api.127.0.0.1.nip.io/api/me | head -5                      # 401, no token
curl -si -H "Authorization: Bearer $(make -s token USER=bob)" \
  http://api.127.0.0.1.nip.io/api/admin/stats                              # 403, bob is not admin
curl -si -H "Authorization: Bearer $(make -s token USER=carol)" \
  http://api.127.0.0.1.nip.io/api/orders                                   # 403, carol has no roles
```

Example `/api/me` for alice (mock IdP, generic flavor, token from the `cli` client):

```json
{
  "sub": "8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01",
  "name": "Alice Admin",
  "preferred_username": "alice",
  "email": "alice@example.com",
  "roles": ["admin", "user"],
  "claims": {
    "iss": "http://idp.127.0.0.1.nip.io", "sub": "8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01", "aud": ["k8sgateway-api"],
    "exp": 1789697421, "iat": 1789697121, "nbf": 1789697121, "jti": "34b9e8ae-a923-4dba-b063-4a170ec26c13",
    "azp": "cli", "scope": "openid",
    "name": "Alice Admin", "preferred_username": "alice", "email": "alice@example.com", "email_verified": true,
    "roles": ["admin", "user"], "groups": ["admin", "user"]
  }
}
```

`roles` at the top level are the *application* roles derived from `ROLES_CLAIM`;
`claims` is the raw access-token payload (Keycloak adds `realm_access`, Entra
`tid`/`oid`/`scp`, Oracle `user_id`/`tok_type` - see the mock IdP flavors).

Log lines (`kubectl -n k8sgateway logs deploy/rest-api`):

```json
{"time":"...","level":"INFO","msg":"oidc verifier ready","issuer":"http://idp.127.0.0.1.nip.io","issuer_claim":"http://idp.127.0.0.1.nip.io","jwks_uri":"http://idp.127.0.0.1.nip.io/jwks","audience":["k8sgateway-api"],"roles_claim":"roles","attempt":1}
{"time":"...","level":"INFO","msg":"request","method":"GET","path":"/api/me","status":200,"duration_ms":1.524,"bytes":538,"request_id":"<pod>/HjILbZ7w2Q-000002","sub":"8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01","roles":["admin","user"]}
{"time":"...","level":"WARN","msg":"token rejected","reason":"token expired: oidc: token is expired (Token Expiry: ...)","path":"/api/orders"}
{"time":"...","level":"INFO","msg":"request","method":"GET","path":"/api/orders","status":401,"duration_ms":0.036,"bytes":88,"request_id":"<pod>/HjILbZ7w2Q-000003"}
```

### Run locally without Kubernetes

```bash
# terminal 1: the mock IdP on :8081 (image built by `make build`)
docker run --rm -p 8081:8080 -e MOCK_ISSUER=http://localhost:8081 k8sgateway/mock-idp:dev
# terminal 2: the API on :8080 pointing at it
cd apps/rest-api && OIDC_ISSUER=http://localhost:8081 CORS_ORIGINS=http://localhost:4200 go run ./cmd/api
# terminal 3
TOKEN=$(curl -s -X POST http://localhost:8081/token -d grant_type=password -d client_id=cli \
  -d username=alice -d password=alice -d scope=openid | jq -r .access_token)
curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/api/me | jq
```

## Build and test

```bash
cd apps/rest-api
go vet ./... && go test ./...             # unit tests, no network, no IdP needed
docker build -t k8sgateway/rest-api:dev . # multi-stage: golang:1.27-alpine -> gcr.io/distroless/static-debian13:nonroot, ~4.6 MB
```

The tests use an in-memory IdP (`internal/auth/authtest`): a fresh RSA key, an
`httptest` server for discovery + JWKS and a hand-rolled RS256 signer, so the
suite covers real signature checks, key rotation, JWKS caching, `alg=none` and
`HS256` rejection, issuer/audience mismatch, `exp`/`nbf` tolerance, the
`OIDC_ISSUER_CLAIM` and `OIDC_JWKS_URI` modes, the roles-claim extraction and
the full 200/401/403 matrix for alice, bob and carol.

## Kubernetes notes

* Container: `gcr.io/distroless/static-debian13:nonroot`, uid 65532, static
  binary, read-only root filesystem is fine, no capabilities needed.
* Probes: `livenessProbe` -> `GET /healthz`, `readinessProbe` -> `GET /readyz`
  (port 8080). A pod stays not-ready until the IdP answered discovery **and**
  the JWKS probe, so readiness is coupled to the IdP: with Keycloak (several
  minutes to start on kind) expect the pod to be `0/1 Running` that long -
  liveness is `/healthz`, so it is never restarted for it, but rollout waits
  must be generous or wait for the IdP first. `kubectl describe` and the
  `/readyz` body show the last discovery error. That body contains the
  configured issuer URL and the Go network error and is reachable through the
  gateway - fine for a tutorial, but strip the reason (or do not route
  `/readyz`) in production.
* Shutdown: on SIGTERM readiness flips to 503, the process waits 3 s (only when
  `KUBERNETES_SERVICE_HOST` is set) for endpoints to drain, then drains in-flight
  requests for up to 20 s. Use `terminationGracePeriodSeconds: 30`.
* Pods resolve `*.127.0.0.1.nip.io` to the gateway (CoreDNS rewrite), so the
  public issuer URL works in-cluster and tokens validate with the same `iss`
  browsers see. `OIDC_JWKS_URI` can still point at the internal Service if you
  prefer to keep key fetches off the gateway.

## Layout

```
cmd/api/main.go            env config, background discovery with backoff, HTTP server, graceful shutdown
internal/auth/verifier.go  go-oidc setup: discovery / JWKS override / issuer-claim override, alg allow-list, aud + skew checks
internal/auth/middleware.go Bearer extraction, 401 challenges, Principal in context, RequireRole (403)
internal/auth/roles.go     dotted-path roles extraction, mapping to application roles
internal/auth/authtest/    fake IdP for tests (not compiled into the binary)
internal/api/              chi router (CORS before auth), handlers, 200/401/403 matrix test
internal/orders/           in-memory order store
internal/httpx/            JSON helpers, per-request log line, panic recovery
```
