# The mock IdP

The mock IdP (`apps/mock-idp`) is a small, readable OpenID Connect provider that the whole stack runs against by default. It boots in about a second, needs no network, knows exactly three users, and can shape its access tokens like Keycloak, Microsoft Entra ID or Oracle IAM Identity Domains. It exists so that you can develop and debug every application in this repository before a real tenant exists - and it is emphatically not a product: passwords equal usernames, everything lives in memory, and it must never leave a development environment.

## What you will learn

- why a development IdP is worth having and what makes this one credible enough to develop against
- which endpoints and grants it implements, and what its discovery document looks like
- how `users.json`, `clients.json`, the env file and the signing-key Secret reach the pod
- how the four token flavors (`generic`, `keycloak`, `entra`, `oracle`) let you test your role mapping before you have a tenant
- how the SSO session, logout and the token debugger behave, and where the mock stops

## Why a development identity provider

A real IdP is the wrong tool for the inner development loop: Keycloak needs 1.5 GiB of memory and a JVM that takes about 15 seconds to start (minutes on the first run, when its image is pulled), cloud tenants need an account, an administrator, HTTPS redirect URIs and network access, and none of them let you look inside a failed login. The mock trades all of that for four properties:

| property | what it means here |
|---|---|
| fast and offline | one Node process, 64 MiB, no database; ready in seconds |
| deterministic | alice/bob/carol with fixed `sub` values, roles and client secrets, identical to the Keycloak realm in [chapter 5](05-keycloak.md) |
| honest protocol | discovery, JWKS, code flow with mandatory PKCE, `state`, `nonce`, `at_hash`, rotating refresh tokens - the applications exercise the code paths they will use against a real IdP |
| imitation | `MOCK_FLAVOR` reproduces the claim layout of Keycloak, Entra ID and Oracle IAM Identity Domains, so your roles-claim configuration can be rehearsed locally |

Everything is observable: a dashboard at `/`, a token debugger at `/debug/token`, and one JSON log line per request with `sub` and `roles` once the caller is known.

## What it implements

The server is one Express 5 application ([apps/mock-idp/src/server.js](../apps/mock-idp/src/server.js)) with `jose` for RS256 signing and no other runtime dependencies.

| method | path | purpose |
|---|---|---|
| GET | `/.well-known/openid-configuration` | discovery document |
| GET | `/jwks` | signing key as a JWK Set (`kid` = RFC 7638 thumbprint) |
| GET, POST | `/authorize` | login page / form submission; redirects back with `code` and `state` |
| POST | `/token` | grants `authorization_code`, `refresh_token`, `client_credentials`, `password` |
| GET, POST | `/userinfo` | claims of the bearer token's user (`sub` equals the ID token's `sub`) |
| POST | `/introspect` | RFC 7662 introspection for access and refresh tokens |
| POST | `/revoke` | RFC 7009 revocation of refresh tokens |
| GET, POST | `/logout` | `end_session_endpoint`: ends the SSO session, revokes its refresh tokens |
| GET | `/` | dashboard: users, clients, endpoints, curl examples, flavors, configuration |
| GET, POST | `/debug/token` | paste a JWT, get header, payload and validity checks |
| GET | `/healthz`, `/readyz` | liveness and readiness (readiness also reports flavor and `kid`) |

The discovery document is what every application reads first. Captured from the running cluster and shortened (`claims_supported`, `response_modes_supported` and a few more fields omitted):

```bash
curl -s http://idp.127.0.0.1.nip.io/.well-known/openid-configuration | jq .
```

```json
{
  "issuer": "http://idp.127.0.0.1.nip.io",
  "authorization_endpoint": "http://idp.127.0.0.1.nip.io/authorize",
  "token_endpoint": "http://idp.127.0.0.1.nip.io/token",
  "userinfo_endpoint": "http://idp.127.0.0.1.nip.io/userinfo",
  "jwks_uri": "http://idp.127.0.0.1.nip.io/jwks",
  "end_session_endpoint": "http://idp.127.0.0.1.nip.io/logout",
  "introspection_endpoint": "http://idp.127.0.0.1.nip.io/introspect",
  "revocation_endpoint": "http://idp.127.0.0.1.nip.io/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials", "password"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "scopes_supported": ["openid", "profile", "email", "offline_access"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
  "code_challenge_methods_supported": ["S256"]
}
```

Note the `issuer`: the exact string `http://idp.127.0.0.1.nip.io`, no trailing slash. It is identical in every token's `iss`, in every overlay's `OIDC_ISSUER` and in the gateway `SecurityPolicy` of [chapter 12](12-gateway-jwt.md). Browsers and pods can both use it thanks to the CoreDNS rewrite described in [chapter 2](02-architecture.md).

![Mock IdP login page: a username and password form for the Angular client, plus one-click buttons "Sign in as alice / bob / carol" showing each user's roles](images/screenshots/mock-idp-login.png)

*The login page the Angular SPA redirects to. The one-click buttons post `user=<name>` and skip the password; the form posts `username`/`password`.*

![Mock IdP dashboard listing the demo users, the four clients with grants and redirect URIs, all endpoints, curl examples, the flavor table and the effective configuration](images/screenshots/mock-idp-dashboard.png)

*The dashboard at `http://idp.127.0.0.1.nip.io/`. It also shows whether this browser has an SSO session and how many codes, refresh tokens and sessions are in memory.*

### Where the code flow lives

The flow itself is explained in [chapter 1](01-concepts.md). In this code, `GET /authorize` validates first: an unknown `client_id` or an untrusted `redirect_uri` is shown as an error page and never redirected; other problems go back to the client as `error=...`; a public client without `code_challenge` is refused, because PKCE is what protects an SPA against a stolen code. `POST /authorize` re-validates the hidden form fields, checks the password in constant time and stores a single-use code (60 s) with `redirect_uri`, `scope`, `nonce` and the PKCE challenge. `POST /token` authenticates the client, consumes the code even when the exchange fails, checks client and `redirect_uri`, verifies `code_verifier` - and rejects a verifier for a flow that never sent a challenge (the RFC 9700 downgrade check). `issueTokens` in [apps/mock-idp/src/oidc.js](../apps/mock-idp/src/oidc.js) signs the access token and, when `openid` was requested, an ID token with `aud = client_id`, the `nonce` and a correct `at_hash`. Refresh tokens are opaque random strings stored server-side, never JWTs.

## Users, clients and how they reach the pod

`users.json` is an array of objects; `username`, `password`, `name` and `email` are required, the rest is derived when missing (`sub` becomes a stable UUID from the username, `given_name`/`family_name` are split from `name`, `groups` defaults to `roles`):

```json
{
  "username": "alice",
  "password": "alice",
  "sub": "8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01",
  "name": "Alice Admin",
  "email": "alice@example.com",
  "email_verified": true,
  "roles": ["admin", "user"]
}
```

`clients.json` entries need only `client_id`. A `client_secret` makes the client confidential, `grant_types` defaults to `authorization_code` + `refresh_token`, `redirect_uris` accept a trailing `*` as a prefix wildcard, and `roles` feeds `client_credentials` tokens, which have no user.

| client_id | type | grants | used by |
|---|---|---|---|
| `angular-app` | public | authorization_code, refresh_token | the SPA ([chapter 8](08-angular.md)); PKCE required |
| `nextjs-app` | confidential, secret `nextjs-secret` | authorization_code, refresh_token | the BFF ([chapter 9](09-nextjs.md)) |
| `cli` | public | password, refresh_token | `scripts/get-token.sh`, `scripts/test.sh`, CI - never an application |
| `svc-batch` | confidential, secret `svc-batch-secret` | client_credentials | machine-to-machine demo; tokens carry `roles: ["admin"]` |

In the cluster ([deploy/idp/mock](../deploy/idp/mock)) the pieces arrive like this:

| what | how | where the pod sees it |
|---|---|---|
| users | `configMapGenerator` `mock-idp-users` from [deploy/idp/mock/users.json](../deploy/idp/mock/users.json) (identical to the file in `apps/mock-idp`) | volume at `/config`, `MOCK_USERS_FILE=/config/users.json` |
| settings | `configMapGenerator` `mock-idp-config` from [deploy/idp/mock/mock-idp.env](../deploy/idp/mock/mock-idp.env), injected with `envFrom` | `MOCK_ISSUER`, `MOCK_FLAVOR`, `MOCK_AUDIENCE`, TTLs, `MOCK_ALLOW_ANY_REDIRECT`, ... |
| clients | not mounted: the image's built-in [apps/mock-idp/clients.json](../apps/mock-idp/clients.json) is used (`MOCK_CLIENTS_FILE` unset) | `/app/clients.json` |
| signing key | Secret `mock-idp-key`, `optional: true` | `/keys/key.pem`, `MOCK_KEY_FILE=/keys/key.pem` |

Generated ConfigMaps carry a content hash in their name (`mock-idp-config-bccf848k9h`), so any edit to the env or users file rolls the Deployment on the next `scripts/deploy.sh mock`. To change the *clients* in the cluster you would add a ConfigMap and set `MOCK_CLIENTS_FILE`, or rebuild the image; the built-in list is what every overlay expects.

### The persistent signing key

Without a key file the mock generates a new RSA key at every start - fine for a unit test, bad for a cluster, because the REST API, the GraphQL API and a gateway `SecurityPolicy` cache the JWKS and would reject every new token after a pod restart until their cache expires. [scripts/lib.sh](../scripts/lib.sh) therefore creates the key once; `scripts/deploy.sh` calls this for every `mock*` overlay:

```bash
ensure_mock_signing_key() {
  k -n idp get secret mock-idp-key >/dev/null 2>&1 && return 0
  need openssl
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null \
    | k -n idp create secret generic mock-idp-key --from-file=key.pem=/dev/stdin >/dev/null
  ok "Secret idp/mock-idp-key created (signing key of the mock IdP, demo value)"
}
```

[apps/mock-idp/src/keys.js](../apps/mock-idp/src/keys.js) loads the PEM (PKCS#1 or PKCS#8), derives the `kid` as the RFC 7638 thumbprint of the public key and publishes only the public members in `/jwks`. Same key after a restart, same `kid`:

```bash
kubectl -n idp get secret mock-idp-key            # DATA 1 (key.pem)
curl -s http://idp.127.0.0.1.nip.io/readyz        # {"status":"ready",...,"kid":"nPy6kG..."}
curl -s http://idp.127.0.0.1.nip.io/jwks | jq '.keys[0].kid'
```

The volume is `optional`, so a bare `kubectl apply -k deploy/overlays/mock` still works - with an ephemeral key.

## Grants and errors

Two grants are for applications, two exist only for scripts. **Authorization code + PKCE** is what the Angular SPA and the Next.js BFF use; exercise it by signing in through either application. **Password grant** on the public client `cli` is what `scripts/get-token.sh` uses so that curl-based tests get a token without a browser (real IdPs discourage or have removed this grant):

```bash
TOKEN=$(scripts/get-token.sh alice mock)
scripts/get-token.sh --decode bob mock          # header and payload instead of the raw token
curl -s -H "Authorization: Bearer $TOKEN" http://api.127.0.0.1.nip.io/api/me | jq .
```

**Client credentials** for `svc-batch` produce a token without a user: no profile claims, `preferred_username: "service-account-svc-batch"`, and `roles: ["admin"]` taken from `clients.json`. Both client authentication methods work; `scripts/get-token.sh --client-credentials` does the same:

```bash
curl -s -X POST http://idp.127.0.0.1.nip.io/token -u svc-batch:svc-batch-secret -d grant_type=client_credentials | jq .
```

**Refresh tokens rotate.** Every `authorization_code` and `password` grant on a client that may refresh returns a refresh token (`offline_access` is accepted but not required - see the scope note in [chapter 5](05-keycloak.md)). Using it returns a new one and invalidates the old one:

```bash
IDP=http://idp.127.0.0.1.nip.io
curl -s -X POST $IDP/token -d grant_type=password -d client_id=cli \
  -d username=alice -d password=alice -d 'scope=openid profile email' > /tmp/tokens.json
RT=$(jq -r .refresh_token /tmp/tokens.json)
curl -s -X POST $IDP/token -d grant_type=refresh_token -d client_id=cli -d refresh_token=$RT | jq .refresh_token
curl -si -X POST $IDP/token -d grant_type=refresh_token -d client_id=cli -d refresh_token=$RT | head -1
```

The second call answers `HTTP/1.1 400 Bad Request` with `{"error":"invalid_grant","error_description":"refresh token is unknown, expired, revoked or already rotated"}`. A refresh may narrow the scope but never widen it.

Errors follow RFC 6749 section 5.2, which matters because `openid-client` and `angular-oauth2-oidc` parse them:

| situation | status | `error` |
|---|---|---|
| unknown client, wrong secret | 401 (+ `WWW-Authenticate: Basic` after Basic auth) | `invalid_client` |
| missing `grant_type`, `code` or `code_verifier` | 400 | `invalid_request` |
| grant not in the list of four / not allowed for this client | 400 | `unsupported_grant_type` / `unauthorized_client` |
| bad code, wrong `redirect_uri`, PKCE mismatch, rotated refresh token, wrong password | 400 | `invalid_grant` |

Token responses carry `Cache-Control: no-store`, `token_type: "Bearer"` and a numeric `expires_in` - `openid-client` is strict about all three.

## Flavors: rehearse a real IdP's token shape

Applications in this repository find roles by reading a configurable dotted path (`ROLES_CLAIM`) from the access token. Which path is right depends on the provider, and you normally learn that only once you decode a token from a real tenant. `MOCK_FLAVOR` closes that gap: only the access token changes; the ID token, `/userinfo` and all flows stay the same ([apps/mock-idp/src/flavors.js](../apps/mock-idp/src/flavors.js)).

| `MOCK_FLAVOR` | imitates | `ROLES_CLAIM` | what is different |
|---|---|---|---|
| `generic` | a typical OIDC provider | `roles` | flat `roles[]` and `groups[]`, `aud` as an array |
| `keycloak` | Keycloak 26 realm | `realm_access.roles` | realm roles mixed with `default-roles-k8sgateway`, `offline_access`, `uma_authorization`; `resource_access.<audience>.roles`; `typ`, `sid`, `acr`, `allowed-origins` |
| `entra` | Entra ID v2.0 access token | `roles` | `aud` is a **string**; `oid`, `tid`, `uti`, `ver`; `scp: access_as_user`; `preferred_username` is the email; no `jti` |
| `oracle` | Oracle IAM Identity Domains | `groups` | `sub` is the login name; `user_id`, `user_displayname`, `tenant`, `tok_type: AT`, `client_id`/`client_name`; combine with `MOCK_ISSUER_CLAIM=https://identity.oraclecloud.com/` |

The tokens below are real output. To reproduce them without touching the cluster, run the image locally on a free port (build it first with `scripts/build.sh mock-idp` or `docker build -t k8sgateway/mock-idp:dev apps/mock-idp`):

```bash
docker run --rm -d --name mock-entra -p 127.0.0.1:18083:8080 \
  -e MOCK_ISSUER=http://localhost:18083 -e MOCK_FLAVOR=entra k8sgateway/mock-idp:dev
curl -s -X POST http://localhost:18083/token -d grant_type=password -d client_id=cli \
  -d username=alice -d password=alice -d 'scope=openid profile email' \
  | jq -r .access_token | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq .
docker rm -f mock-entra
```

The other outputs come from the same command with a different `MOCK_FLAVOR`: the `keycloak` run used port 18082 (`-p 127.0.0.1:18082:8080 -e MOCK_ISSUER=http://localhost:18082`, hence its `iss`), and the `oracle` run adds `-e MOCK_ISSUER_CLAIM=https://identity.oraclecloud.com/`.

`MOCK_FLAVOR=generic` (the cluster default; `scripts/get-token.sh --decode alice mock` shows the same):

```json
{
  "iss": "http://idp.127.0.0.1.nip.io",
  "sub": "8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01",
  "aud": ["k8sgateway-api"],
  "exp": 1789702939, "iat": 1789702639, "nbf": 1789702639,
  "jti": "0a37d212-7fc2-4fb9-9ea2-ec4891237f24",
  "azp": "cli",
  "scope": "openid profile email",
  "preferred_username": "alice",
  "name": "Alice Admin",
  "email": "alice@example.com",
  "email_verified": true,
  "roles": ["admin", "user"],
  "groups": ["admin", "user"]
}
```

`MOCK_FLAVOR=keycloak` (same command with `MOCK_FLAVOR=keycloak`, run on port 18082 - hence its `iss`) - note the extra realm roles your mapping must ignore (it does: the rule is "contains `ROLE_ADMIN`", not "equals"):

```json
{
  "exp": 1789702951, "iat": 1789702651, "nbf": 1789702651,
  "jti": "e4d1e518-9c94-41f6-998b-be66fc587347",
  "iss": "http://localhost:18082",
  "aud": ["k8sgateway-api"],
  "sub": "8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01",
  "typ": "Bearer",
  "azp": "cli",
  "sid": "0d2f4fdc-71e7-49c8-bff5-f0861205e03c",
  "session_state": "0d2f4fdc-71e7-49c8-bff5-f0861205e03c",
  "acr": "1",
  "allowed-origins": [],
  "realm_access": { "roles": ["default-roles-k8sgateway", "offline_access", "uma_authorization", "admin", "user"] },
  "resource_access": {
    "k8sgateway-api": { "roles": ["admin", "user"] },
    "account": { "roles": ["manage-account", "view-profile"] }
  },
  "scope": "openid profile email",
  "preferred_username": "alice",
  "name": "Alice Admin",
  "email": "alice@example.com",
  "email_verified": true,
  "given_name": "Alice",
  "family_name": "Admin",
  "roles": ["admin", "user"],
  "groups": ["admin", "user"]
}
```

`MOCK_FLAVOR=entra` - `aud` is a plain string and `azpacr` is `"0"` for a public client (`"1"` for `svc-batch`, whose app-only token also gets `idtyp: "app"` and no `scp`):

```json
{
  "aud": "k8sgateway-api",
  "iss": "http://localhost:18083",
  "iat": 1789702651, "nbf": 1789702651, "exp": 1789702951,
  "azp": "cli",
  "azpacr": "0",
  "name": "Alice Admin",
  "oid": "8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01",
  "preferred_username": "alice@example.com",
  "scp": "access_as_user",
  "roles": ["admin", "user"],
  "sub": "8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01",
  "tid": "ccf0eb9f-aabb-4b25-a078-dad2022fafdb",
  "uti": "JtlNIxP1hH3KS9WT1GYvKQ",
  "ver": "2.0"
}
```

`MOCK_FLAVOR=oracle` with `-e MOCK_ISSUER_CLAIM=https://identity.oraclecloud.com/` - the `iss` no longer matches the URL the token came from, which is exactly the situation `OIDC_ISSUER_CLAIM` exists for ([chapter 7](07-oracle-iam.md)):

```json
{
  "iss": "https://identity.oraclecloud.com/",
  "sub": "alice",
  "sub_type": "user",
  "user_id": "8f1d2c5e-0a4b-4a9e-9b1a-1e2f3a4b5c01",
  "user_displayname": "Alice Admin",
  "user_tenantname": "k8sgateway",
  "client_id": "cli",
  "client_name": "Scripts and tests (password grant)",
  "client_tenantname": "k8sgateway",
  "tenant": "k8sgateway",
  "tok_type": "AT",
  "jti": "aa80ba9f-d505-4432-b1e4-b3faa689f195",
  "aud": ["k8sgateway-api"],
  "scope": "openid profile email",
  "groups": ["admin", "user"],
  "sid": "a96d7520-5e2f-4126-961c-5d7e1b217a8a",
  "iat": 1789702651, "exp": 1789702951
}
```

One honesty note: the `entra` layout follows Microsoft's published v2.0 sample token and the `oracle` layout follows Oracle's documented claim table, but whether a real Oracle domain puts group names into the *access* token, and under which name, is not settled by the documentation - verify with a decoded token from your tenant. The mock cannot tell you what your tenant does; it lets you make sure that, once you know, a single `ROLES_CLAIM` change is all your applications need.

### Trying a flavor in the cluster

Edit `MOCK_FLAVOR` in [deploy/idp/mock/mock-idp.env](../deploy/idp/mock/mock-idp.env) and the matching `ROLES_CLAIM` in the three `*.env` files plus `rolesClaim` in `angular-config.json` under [deploy/overlays/mock](../deploy/overlays/mock), then redeploy:

```bash
make switch IDP=mock        # = scripts/switch-idp.sh mock
scripts/test.sh mock        # alice admin+user, bob user, carol none - with the new claim path
```

The ConfigMap hashes change, so the mock IdP and the applications roll; the signing key stays. For `entra` nothing else changes - `ROLES_CLAIM` stays `roles` and the APIs accept `aud` as a string or an array. For `oracle`, also set `MOCK_ISSUER_CLAIM=https://identity.oraclecloud.com/` in the env file, `OIDC_ISSUER_CLAIM` to the same value in the application env files, and both `strictDiscoveryDocumentValidation: false` and `skipIssuerCheck: true` in the Angular config, as [deploy/overlays/oracle/angular-config.json](../deploy/overlays/oracle/angular-config.json) has them - the discovery document's `issuer` then differs from the URL it was fetched from, like the real thing. The complete recipe, with the expected output, is in [chapter 7](07-oracle-iam.md#rehearse-the-oracle-token-shape-with-the-mock-idp). [Chapter 13](13-switching-idps.md) explains the switch mechanics.

## The token debugger

`http://idp.127.0.0.1.nip.io/debug/token` takes any JWT and shows the decoded header and payload next to five checks: signature against the mock's current key, `kid` equals the current `kid`, `alg` is `RS256`, `iss` equals the mock's issuer claim, and `exp` (plus `nbf` if present) against the clock. The page needs no JavaScript, so it also works for a token copied from the Angular profile page or a pod log. Tokens from other providers decode fine but fail the signature and issuer checks - a useful reminder of what your API would do with them.

## SSO session and logout

After a successful login the mock sets a cookie `mock_idp_session` (HttpOnly, `SameSite=Lax`, `Secure` only when the issuer is https). The cookie carries an HMAC-signed session id; the session itself lives in memory for `MOCK_SESSION_TTL` (default 8 hours). On the next `/authorize` a valid session skips the login page - the second application you open signs you in without a prompt, as a real IdP would. `prompt=login` (or `max_age=0`) forces the login page, `prompt=none` never shows UI and answers `error=login_required` without a session, `login_hint` pre-fills the username:

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://idp.127.0.0.1.nip.io/authorize?response_type=code&client_id=angular-app&redirect_uri=http://angular.127.0.0.1.nip.io/callback&scope=openid&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&prompt=none"
# 302 http://angular.127.0.0.1.nip.io/callback?error=login_required&error_description=no+SSO+session&state=abc
```

`GET|POST /logout` is the `end_session_endpoint` both frontends call (`logOut()` in Angular, `/api/auth/logout` in Next.js). It deletes the session, revokes every refresh token minted in that session, clears the cookie and redirects to `post_logout_redirect_uri` when it is allowed for the client - otherwise it renders a "Signed out" page. An `id_token_hint` is checked by signature only, because the ID token is usually expired by the time a user logs out. Access tokens are stateless JWTs and stay valid until `exp` (5 minutes by default) - the trade-off every JWT-based IdP makes.

## Limitations (on purpose)

- **In-memory, one replica.** Codes, refresh tokens and sessions vanish on restart; `replicas: 1` is not a suggestion.
- **Never production.** Passwords equal usernames, secrets sit in a JSON file, one-click logins exist, and `MOCK_ALLOW_ANY_REDIRECT=true` (the dev default) turns `/authorize` error redirects and `/logout` into an open redirector. Set it to `false` to rehearse the strict redirect-URI matching of real IdPs.
- **Plain HTTP.** Clients need their "allow http" switch (`requireHttps: false` in Angular, `allowInsecureRequests` in the BFF). Real IdPs are HTTPS only; the optional TLS mode in [deploy/tls/README.md](../deploy/tls/README.md) removes the difference.
- **No consent screen, `request`/`claims` parameters, back-channel logout, user management UI or MFA.** If your application depends on one of these, test it against Keycloak.
- **Imitation, not emulation.** Flavors reproduce claim layouts, not provider behavior (token lifetimes, consent, group overage, pairwise subjects).

## Next

[Keycloak in the cluster](05-keycloak.md)
