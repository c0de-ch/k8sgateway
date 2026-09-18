# mock-idp - development OpenID Connect provider

A small, readable OIDC provider (Node 22, Express 5, jose 6, no other runtime dependencies) that
serves as the *development* identity provider of the k8sgateway tutorial. It implements the parts of
OAuth 2.0 / OpenID Connect the sample applications need and can **imitate the access-token shapes**
of Keycloak, Microsoft Entra ID and Oracle IAM Identity Domains. Applications are developed against
the mock and later switched to the real IdP by configuration only.

It is a mock: passwords equal usernames, one-click logins exist, secrets live in a JSON file and
everything is kept in memory (single replica). Never expose it outside a development environment.

## What it does

- Discovery (`/.well-known/openid-configuration`) and JWKS (`/jwks`); RS256, `kid` = RFC 7638 thumbprint
- Authorization code flow with PKCE S256 (mandatory for public clients), `state`, `nonce`,
  `prompt=none|login`, `login_hint`, `max_age`, `response_mode=query|fragment`
- Login page with a password form and one-click "Sign in as alice / bob / carol" buttons
- SSO session cookie (signed, HttpOnly) - returning users get a code without a login page unless `prompt=login`
- Token endpoint: `authorization_code`, `refresh_token` (rotating), `client_credentials`, `password`
  (scripts only); `client_secret_basic` and `client_secret_post`; RFC 6749 error JSON with 400/401
- ID token with `nonce`, `aud = client_id` and a correct `at_hash`; access token header `{alg: RS256, typ: JWT, kid}`
- `/userinfo`, `/introspect` (RFC 7662), `/revoke` (RFC 7009), `/logout` (RP-initiated logout with
  `id_token_hint`, `post_logout_redirect_uri`, `state`)
- CORS (`Access-Control-Allow-Origin: *`) so a browser SPA can call discovery, `/jwks`, `/token`, `/userinfo`
- Dashboard at `/` (users, clients, endpoints, curl examples) and a token debugger at `/debug/token`
- One JSON log line per request with `sub` and `roles` once the caller is known

## Run it

```bash
# locally (Node 22)
npm ci
MOCK_ISSUER=http://localhost:8080 node src/server.js
open http://localhost:8080

# as a container
docker build -t k8sgateway/mock-idp:dev .
docker run --rm -p 8080:8080 -e MOCK_ISSUER=http://localhost:8080 k8sgateway/mock-idp:dev
```

In the tutorial cluster it runs as `mock-idp.idp.svc` behind the gateway at `http://idp.127.0.0.1.nip.io`
(the default `MOCK_ISSUER`), so browsers and pods use the same issuer URL.

## Configuration (environment variables)

| variable | default | meaning |
|---|---|---|
| `MOCK_ISSUER` | `http://idp.127.0.0.1.nip.io` | Base URL of all endpoints; discovery is served at `${MOCK_ISSUER}/.well-known/openid-configuration` |
| `MOCK_ISSUER_CLAIM` | = `MOCK_ISSUER` | Value of `iss` in tokens **and** of `issuer` in the discovery document. Set to `https://identity.oraclecloud.com/` to imitate Oracle IAM, whose issuer differs from its endpoint URLs |
| `PORT` | `8080` | Listen port |
| `MOCK_FLAVOR` | `generic` | `generic`, `keycloak`, `entra` or `oracle` - shape of the access token (see below) |
| `MOCK_AUDIENCE` | `k8sgateway-api` | `aud` of access tokens (array; a string for `entra`) |
| `MOCK_ACCESS_TOKEN_TTL` | `300` | Access token lifetime (seconds) |
| `MOCK_ID_TOKEN_TTL` | `300` | ID token lifetime (seconds) |
| `MOCK_REFRESH_TOKEN_TTL` | `1800` | Refresh token lifetime (seconds); tokens rotate on every use |
| `MOCK_ALLOW_ANY_REDIRECT` | `true` | `true`: any http(s) `redirect_uri` is accepted (dev). `false`: only registered URIs (trailing `*` = prefix) |
| `MOCK_KEY_FILE` | unset | PKCS#8 (or PKCS#1) RSA private key PEM. Created if missing; unset = new key on every start |
| `MOCK_USERS_FILE` | `./users.json` | Users (see format below) |
| `MOCK_CLIENTS_FILE` | `./clients.json` | Clients (see format below) |
| `MOCK_SESSION_TTL` | `28800` | SSO session lifetime (seconds) |
| `MOCK_COOKIE_SECRET` | random | HMAC key of the session cookie |
| `MOCK_TENANT` | `k8sgateway` | Tenant/realm name used by the keycloak/oracle/entra flavors |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Authorization codes live 60 seconds and are single use.

## Demo users and clients

| username | password | name | email | roles |
|---|---|---|---|---|
| alice | alice | Alice Admin | alice@example.com | admin, user |
| bob | bob | Bob User | bob@example.com | user |
| carol | carol | Carol Guest | carol@example.com | (none) |

| client_id | type | grants | notes |
|---|---|---|---|
| `angular-app` | public | authorization_code, refresh_token | PKCE required; redirect `http(s)://angular.127.0.0.1.nip.io/*`, `http://localhost:4200/*` |
| `nextjs-app` | confidential (`nextjs-secret`) | authorization_code, refresh_token | redirect `http(s)://next.127.0.0.1.nip.io/api/auth/callback` |
| `cli` | public | password, refresh_token | scripts and tests only |
| `svc-batch` | confidential (`svc-batch-secret`) | client_credentials | tokens carry `roles: ["admin"]` from the client entry |

`users.json` entries: `username`, `password`, `name`, `email` (required), `sub`, `given_name`,
`family_name`, `email_verified`, `roles`, `groups` (optional). `clients.json` entries: `client_id`
(required), `name`, `client_secret` (present = confidential client), `grant_types`, `redirect_uris`,
`post_logout_redirect_uris`, `web_origins`, `roles` (used for `client_credentials` tokens).

A refresh token is issued for **every** `authorization_code` and `password` grant when the client
may use the `refresh_token` grant; `offline_access` is accepted but not required (Entra ID requires
it, Keycloak must not receive it, the mock does not care). The sample apps therefore request
`openid profile email` against the mock and Keycloak and add `offline_access` only for Entra/Oracle.

## Endpoints

| method | path | purpose |
|---|---|---|
| GET | `/.well-known/openid-configuration` | discovery document |
| GET | `/jwks` | signing keys `{"keys":[{kty, n, e, kid, use, alg}]}` |
| GET, POST | `/authorize` | login page / form submission; redirects with `code` + `state` |
| POST | `/token` | `grant_type=authorization_code`, `refresh_token`, `client_credentials`, `password` |
| GET, POST | `/userinfo` | claims of the bearer token's user (same `sub` as the ID token) |
| POST | `/introspect` | `{active, ...claims}` for access and refresh tokens (client auth required) |
| POST | `/revoke` | revokes a refresh token |
| GET, POST | `/logout` | `end_session_endpoint`: ends the SSO session, revokes its refresh tokens, redirects to `post_logout_redirect_uri` |
| GET | `/` | dashboard |
| GET, POST | `/debug/token` | paste a JWT: decoded header/payload + signature/exp/iss checks |
| GET | `/healthz`, `/readyz` | liveness / readiness |

## curl examples

```bash
IDP=http://idp.127.0.0.1.nip.io      # or http://localhost:8080 when running locally

curl -s $IDP/.well-known/openid-configuration | jq .
curl -s $IDP/jwks | jq .

# password grant - alice has admin + user; the response always includes a refresh token
TOKEN=$(curl -s -X POST $IDP/token -d grant_type=password -d client_id=cli \
  -d username=alice -d password=alice -d 'scope=openid profile email' \
  | tee /tmp/tokens.json | jq -r .access_token)

# client credentials with client_secret_basic - roles come from clients.json
curl -s -X POST $IDP/token -u svc-batch:svc-batch-secret -d grant_type=client_credentials | jq .

# refresh (rotating: the previous refresh token stops working)
curl -s -X POST $IDP/token -d grant_type=refresh_token -d client_id=cli \
  -d refresh_token=$(jq -r .refresh_token /tmp/tokens.json) | jq .

curl -s $IDP/userinfo -H "Authorization: Bearer $TOKEN" | jq .
curl -s -X POST $IDP/introspect -d client_id=cli -d token=$TOKEN | jq .

# errors follow RFC 6749: 400 {error, error_description}; invalid_client is 401;
# a missing grant_type is invalid_request, an unknown one unsupported_grant_type
curl -si -X POST $IDP/token -d grant_type=password -d client_id=cli -d username=alice -d password=nope
```

## Flavors

Only the **access token** differs; the ID token, `/userinfo` and the flows are the same.

| `MOCK_FLAVOR` | imitates | roles claim (`ROLES_CLAIM`) | notable claims |
|---|---|---|---|
| `generic` | a typical OIDC provider | `roles` | `iss sub aud[] exp iat nbf jti azp scope preferred_username name email email_verified roles[] groups[]` |
| `keycloak` | Keycloak 26 realm | `realm_access.roles` | generic + `realm_access.roles[]`, `resource_access.<audience>.roles[]`, `typ: Bearer`, `sid`, `acr`, `given_name`, `family_name`, `allowed-origins[]` |
| `entra` | Entra ID v2.0 access token | `roles` | `aud` (string), `azp`, `azpacr` (`"0"` public client, `"1"` client secret - Entra's own encoding), `oid`, `tid`, `preferred_username` (email), `scp: access_as_user`, `roles[]`, `ver: 2.0`, `uti` (no `jti`) |
| `oracle` | Oracle IAM Identity Domains | `groups` | `sub` = login name, `user_id`, `user_displayname`, `user_tenantname`, `client_id`, `client_name`, `tenant`, `tok_type: AT`, `aud[]`, `scope`, `groups[]`; combine with `MOCK_ISSUER_CLAIM=https://identity.oraclecloud.com/` |

`client_credentials` tokens have no user claims; their roles come from the client entry. Every
flavor puts the same audience in `aud`, so `OIDC_AUDIENCE=k8sgateway-api` works for all of them.

## How a login works

1. The application redirects the browser to `/authorize?response_type=code&client_id=...&redirect_uri=...&scope=openid...&state=...&nonce=...&code_challenge=...&code_challenge_method=S256`.
2. The mock validates the client and the redirect URI (never redirecting to an unknown one), then
   shows the login page - or, with a valid SSO cookie, skips it.
3. After login it stores a single-use authorization code (60 s) together with the redirect URI,
   scope, nonce and PKCE challenge, and redirects to `redirect_uri?code=...&state=...`.
4. The application POSTs the code to `/token` with its `code_verifier` (public client) or client
   secret (confidential client). The mock checks client, redirect URI and PKCE (a `code_verifier`
   for a request that sent no `code_challenge` is rejected as a PKCE downgrade, RFC 9700), then
   returns the access token (for APIs), the ID token (for the application; `nonce` and `at_hash`
   bind it to this login) and a refresh token.
5. APIs validate the access token with the keys from `/jwks`: signature, `iss`, `aud`, `exp`.

## Files

```
src/server.js   Express app, all routes, entry point
src/oidc.js     at_hash, PKCE, redirect URI matching, client authentication, token minting
src/flavors.js  access/ID token claim shapes per flavor, userinfo claims
src/keys.js     RS256 key loading/generation, JWKS
src/store.js    in-memory TTL stores (codes, refresh tokens, sessions)
src/cookies.js  signed cookie helpers
src/pages.js    login page, dashboard, token debugger (inline CSS, no JS)
src/config.js   environment variables, users.json / clients.json loading
src/util.js     logging, escaping, constant-time compare
users.json, clients.json  demo data
test/*.test.js  node --test suite (discovery, PKCE code flow, grants, flavors, key persistence)
```

## Tests

```bash
npm test          # node --test test/*.test.js - starts real servers on free ports
```

## Limitations (on purpose)

- In-memory state: codes, refresh tokens and SSO sessions vanish on restart; run one replica.
- Without `MOCK_KEY_FILE` every start creates a new key: resource servers that cached the old JWKS
  reject tokens until they refetch (jose waits 30 s between refetches). Mount a volume and set
  `MOCK_KEY_FILE=/data/idp.pem` if that bothers you.
- `MOCK_ALLOW_ANY_REDIRECT=true` (the dev default) makes the mock an **open redirector**: an error
  redirect from `/authorize` (e.g. `response_type=token`) and `/logout?post_logout_redirect_uri=...`
  send the browser to any http(s) URL without a login. Fine on a laptop, one more reason never to
  expose the mock; set it to `false` to rehearse the strict behaviour of real IdPs.
- Plain HTTP issuer: clients need their "allow http" switch (`requireHttps: false`,
  `allowInsecureRequests`). Real IdPs are HTTPS only.
- No consent screen, no `request`/`claims` parameters, no back-channel logout, no user management UI.
