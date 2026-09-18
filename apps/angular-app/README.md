# angular-app - Angular 22 SPA with OIDC login (code flow + PKCE)

The browser application of the k8sgateway tutorial. It signs users in at an external OpenID Connect
identity provider (mock IdP, Keycloak, Microsoft Entra ID or Oracle IAM Identity Domains) and calls the
JWT-protected REST and GraphQL APIs with the access token. The app never sees a password and never
verifies a token itself - it only obtains, stores, refreshes and forwards tokens.

## How it works

1. At startup `provideAppInitializer` fetches `/config.json` (issuer, client id, scopes, API URLs, roles claim).
   Kubernetes mounts this file from a ConfigMap, so switching the IdP is a config change, not a rebuild.
2. `AuthService.init()` configures [angular-oauth2-oidc](https://github.com/manfredsteyer/angular-oauth2-oidc)
   and loads `<issuer>/.well-known/openid-configuration` plus the JWKS.
3. **Login** redirects the browser to the IdP's authorization endpoint with `response_type=code`, a random
   `state`, a `nonce`, and a PKCE `code_challenge` (S256). The `code_verifier` stays in the browser.
4. The IdP authenticates the user and redirects back to `/callback?code=...&state=...`.
5. The library checks `state`, exchanges `code` + `code_verifier` at the token endpoint (no client secret -
   this is a public client) and validates the ID token (`iss`, `aud`, `nonce`, `exp`).
6. Tokens are kept in `localStorage` (session survives reloads and tabs; see the trade-off comment in
   `src/app/app.config.ts`). `setupAutomaticSilentRefresh()` renews the access token with the refresh token at 75 % of
   its lifetime (Keycloak and the mock IdP issue a refresh token for the code flow; Entra and Oracle only with `offline_access`).
7. `HttpClient` calls to `apiUrl` get `Authorization: Bearer <access token>` from the library's interceptor;
   the GraphQL page sets the header by hand with `fetch` to show both options.
8. Roles for menu gating are read from the **access token** at the configured `rolesClaim` path (`roles`,
   `realm_access.roles`, ...). This is a UI hint only - the APIs enforce roles on every request and the
   pages render their 401/403 answers as banners.
9. **Logout** clears the local tokens and redirects to the IdP's `end_session_endpoint` (`id_token_hint`,
   `post_logout_redirect_uri`).
10. `authGuard` keeps the requested URL in the OAuth `state`, so deep links survive the login round trip;
    `roleGuard('admin')` redirects to `/?denied=admin&from=<url>`, where the home page explains the missing role.

| Route       | What it shows                                                                                   |
|-------------|-------------------------------------------------------------------------------------------------|
| `/`         | Who you are, IdP name, links, a 5-step explanation of the flow                                   |
| `/profile`  | ID-token claims, decoded access token (header + payload), expiry countdown, refresh / copy / curl |
| `/orders`   | `GET`/`POST /api/orders` (role `user`)                                                            |
| `/admin`    | `GET /api/admin/stats` + `/api/admin/orders` (role `admin`; hidden for others, API still decides) |
| `/graphql`  | Runs `hello`, `me`, `orders`, `restOrders`, `adminStats` and the `createOrder` mutation           |
| `/callback` | `redirect_uri` of the client - shows "signing you in" while the code is exchanged                |

## Configuration (`public/config.json`)

| key                                 | OIDC contract variable | default (mock IdP)                       | notes |
|-------------------------------------|------------------------|------------------------------------------|-------|
| `idpName`                           | -                      | `Mock IdP`                               | display only |
| `issuer`                            | `OIDC_ISSUER`          | `http://idp.127.0.0.1.nip.io`            | discovery at `<issuer>/.well-known/openid-configuration` |
| `clientId`                          | `OIDC_CLIENT_ID`       | `angular-app`                            | public client, PKCE S256 |
| `scope`                             | `OIDC_SCOPE`           | `openid profile email`                   | add `offline_access` only where the IdP requires it for a refresh token (Entra, Oracle) - never for Keycloak (it would issue offline tokens); Entra also adds `api://<API_CLIENT_ID>/access_as_user` |
| `requireHttps`                      | `OIDC_REQUIRE_HTTPS`   | `false`                                  | must be `false` for plain-http IdPs |
| `strictDiscoveryDocumentValidation` | -                      | `true`                                   | `false` for Entra ID (endpoints do not start with the issuer) |
| `skipIssuerCheck`                   | -                      | `false`                                  | `true` only for Oracle (discovery `issuer` is `https://identity.oraclecloud.com/`) |
| `apiUrl`                            | `API_URL`              | `http://api.127.0.0.1.nip.io`            | receives the bearer token |
| `graphqlUrl`                        | `GRAPHQL_URL`          | `http://graphql.127.0.0.1.nip.io/graphql`| receives the bearer token |
| `rolesClaim`                        | `ROLES_CLAIM`          | `roles`                                  | dotted path in the access token, e.g. `realm_access.roles` |
| `roleUser` / `roleAdmin`            | `ROLE_USER` / `ROLE_ADMIN` | `user` / `admin`                     | claim values that grant the app roles |
| `showDebugInformation`              | -                      | `false`                                  | verbose library logs - they include complete token responses (access, ID and refresh tokens) in the browser console; never enable it in production |

Ready-made variants for the other IdPs are in `public/config.examples/` (`keycloak.json`, `entra.json`,
`oracle.json`, placeholders such as `<TENANT_ID>`); the kustomize overlays in `deploy/overlays/*` mount the
matching file as `/usr/share/nginx/html/config.json`. The examples are excluded from the build output
(`ignore` in `angular.json`), so only the active `config.json` is served by the container.

## Local development

Requires Node 22.22+ (`nvm use 22`).

```bash
npm ci
npm start            # http://localhost:4200
npm test             # vitest + jsdom, no browser needed
npm run build        # dist/angular-app/browser
```

`npm start` works against the mock IdP running in the kind cluster (`make up`) without any change:
the mock IdP accepts any redirect URI by default (`MOCK_ALLOW_ANY_REDIRECT=true`), so
`http://localhost:4200/callback` is fine. For the API calls to succeed from that origin,
`http://localhost:4200` must be part of the APIs' `CORS_ORIGINS`. With Keycloak add
`http://localhost:4200/*` to the client's redirect URIs and web origins first. Point `public/config.json`
at another IdP by copying one of the examples.

## Container

```bash
docker build -t k8sgateway/angular-app:dev .
docker run --rm -p 8080:8080 k8sgateway/angular-app:dev
curl -i localhost:8080/healthz          # 200 ok
curl -i localhost:8080/config.json      # Cache-Control: no-store
```

The multi-stage `Dockerfile` builds with `node:22.23.2-alpine` and serves `dist/angular-app/browser` with
`nginxinc/nginx-unprivileged:1.30.5-alpine` (non-root, port 8080). `nginx.conf` adds the SPA fallback to
`index.html`, gzip, `Cache-Control: no-store` for `index.html` and `config.json`, one-year immutable caching
for the hashed bundles (successful responses only, so a stale-chunk 404 is never cached) and `/healthz`.

## Files

```
src/app/app.config.ts        providers: router, HttpClient (withInterceptorsFromDi), OAuth client, storage, app initializer
src/app/app.ts / app.html    shell: navigation, user + role badges, Login/Logout, error banner
src/app/app.routes.ts        routes and guards
src/app/core/config.service  loads and validates /config.json
src/app/core/auth.service    wraps OAuthService, exposes signals (isAuthenticated, claims, accessToken, roles)
src/app/core/jwt.ts          base64url decode, dotted claim path, role extraction (no library)
src/app/core/api.service     REST calls, errors mapped to {status, message, requiredRole}
src/app/core/graphql.service fetch-based GraphQL client with a hand-set Authorization header
src/app/core/guards.ts       authGuard, roleGuard
src/app/pages/*              home, profile, orders, admin, graphql, callback
src/app/shared/api-error.ts  friendly 401 / 403 / network banners
```
