# Angular SPA: tokens in the browser (code flow + PKCE)

The Angular application in [apps/angular-app](../apps/angular-app) is the classic single-page-application model: a **public client** that signs the user in at the identity provider (IdP) with the Authorization Code flow + PKCE, keeps the tokens in the browser and calls the REST and GraphQL APIs directly with `Authorization: Bearer`. It never sees a password and never verifies a token; it only obtains, stores, refreshes and forwards them. Its OIDC settings come from a `config.json` mounted from a ConfigMap, so one image works with the mock IdP, Keycloak, Microsoft Entra ID or Oracle IAM Identity Domains.

## What you will learn

- how the SPA loads `/config.json` before OAuth starts, and which keys the file has
- what `angular-oauth2-oidc` does at login, on `/callback`, at refresh time and at logout
- how the HTTP interceptor decides which requests get the access token
- how roles are read from the access token for UI gating only
- what the nginx image does (SPA fallback, `no-store` for `config.json`, non-root, `/healthz`)
- how to run the app locally against the kind cluster, and what changes per IdP

## How it works

![Authorization Code flow with PKCE between the SPA, the IdP and the REST API](images/code-flow-pkce.svg)

*The SPA never handles credentials: it receives a one-time `code` from the IdP, exchanges it together with the PKCE verifier for tokens and presents the access token to the APIs, which validate it against the IdP's JWKS.*

The app is zoneless Angular 22 (standalone components, signals) with one OAuth library, [angular-oauth2-oidc](https://github.com/manfredsteyer/angular-oauth2-oidc) 22. Everything security-relevant lives in `src/app/core/`: [config.service.ts](../apps/angular-app/src/app/core/config.service.ts), [auth.service.ts](../apps/angular-app/src/app/core/auth.service.ts), [jwt.ts](../apps/angular-app/src/app/core/jwt.ts) and [guards.ts](../apps/angular-app/src/app/core/guards.ts).

### Startup: `config.json` first, OAuth second

The initializer registered with `provideAppInitializer` in [app.config.ts](../apps/angular-app/src/app/app.config.ts) runs before the first route: it fetches `config.json` with `cache: 'no-store'` and only then configures OAuth:

```ts
provideAppInitializer(async () => {
  const auth = inject(AuthService);
  await auth.init(await inject(ConfigService).load());
}),
```

`init()` maps the file onto an `AuthConfig` and calls `loadDiscoveryDocumentAndTryLogin()`: download `<issuer>/.well-known/openid-configuration` plus the JWKS and, if the URL carries `?code=&state=`, complete the login. Angular's initial navigation starts only after the initializer resolved, so the callback parameters are consumed before the router runs.

The keys mirror the OIDC contract of the repository in camelCase:

| Key | Contract variable | Default (mock IdP) | Notes |
|---|---|---|---|
| `idpName` | - | `Mock IdP` | display name in the navigation bar |
| `issuer` | `OIDC_ISSUER` | `http://idp.127.0.0.1.nip.io` | discovery at `<issuer>/.well-known/openid-configuration` |
| `clientId` | `OIDC_CLIENT_ID` | `angular-app` | public client, no secret |
| `scope` | `OIDC_SCOPE` | `openid profile email` | `offline_access` only where the IdP needs it for a refresh token (Entra, Oracle), never for Keycloak |
| `requireHttps` | `OIDC_REQUIRE_HTTPS` | `false` | the library's default (`remoteOnly`) allows plain http for `localhost` only |
| `strictDiscoveryDocumentValidation` | - | `true` | every endpoint in the discovery document must start with the issuer URL; `false` for Entra ID |
| `skipIssuerCheck` | - | `false` | accept a discovery `issuer` that differs from the URL it was fetched from; `true` only for Oracle |
| `apiUrl`, `graphqlUrl` | `API_URL`, `GRAPHQL_URL` | `http://api.127.0.0.1.nip.io`, `http://graphql.127.0.0.1.nip.io/graphql` | the only URLs that receive the bearer token |
| `rolesClaim` | `ROLES_CLAIM` | `roles` | dotted path inside the **access** token, e.g. `realm_access.roles` |
| `roleUser`, `roleAdmin` | `ROLE_USER`, `ROLE_ADMIN` | `user`, `admin` | claim values that grant the two application roles |
| `showDebugInformation` | - | `false` | verbose library logging (see security notes) |

`issuer`, `clientId`, `scope`, `apiUrl`, `graphqlUrl` and `rolesClaim` are mandatory; otherwise the home page explains the problem and where the file comes from. The image ships [public/config.json](../apps/angular-app/public/config.json) (mock IdP). In Kubernetes the overlay generates a ConfigMap from `deploy/overlays/<idp>/angular-config.json` (`configMapGenerator`, key `config.json`) and [deploy/base/angular-app/deployment.yaml](../deploy/base/angular-app/deployment.yaml) mounts that one key over the baked-in file:

```yaml
volumeMounts:
  - name: config
    mountPath: /usr/share/nginx/html/config.json
    subPath: config.json
    readOnly: true
volumes:
  - name: config
    configMap:
      name: angular-config
```

Kubernetes does not live-update `subPath` mounts, so a changed ConfigMap needs a pod restart; because kustomize appends a content hash to the generated name (`angular-config-g599kgd7t2`), applying another overlay changes the reference and rolls the pod. `curl -si http://angular.127.0.0.1.nip.io/config.json` shows the file the browser gets.

### Login and the `/callback` route

`login(returnUrl)` calls `initCodeFlow(returnUrl)`. The library generates a random `state`, a `nonce` and a PKCE `code_verifier`, stores them in `OAuthStorage`, appends `code_challenge` + `code_challenge_method=S256` to the authorization URL and redirects the page to the IdP. The custom part of `state` carries the requested URL, so deep links survive the round trip.

The IdP returns the browser to `redirect_uri`, always `window.location.origin + '/callback'`. Because the initializer already ran `loadDiscoveryDocumentAndTryLogin()`, by the time [Callback](../apps/angular-app/src/app/pages/callback.ts) renders the library has:

1. compared the returned `state` with the stored one (CSRF protection),
2. POSTed `code` + `code_verifier` + `redirect_uri` + `client_id` to the token endpoint; there is no client secret, PKCE proves that the same browser started the flow,
3. validated the ID token (`iss`, `aud` = client id, `nonce`, `exp`) and stored the access, ID and refresh tokens.

The component only reads `takeReturnUrl()` (same-origin paths, no open redirect) and navigates there; if no tokens arrived it shows the library's error. The mock IdP and Keycloak issue a refresh token without `offline_access`; Entra ID and Oracle only with it, hence the per-IdP scope.

### Auth state as signals (zoneless Angular)

Angular 22 projects are zoneless by default: a promise resolving inside the OAuth library does not trigger change detection. Every library event and every `init()`/`refresh()` completion therefore runs `sync()`, which copies the state into signals: `ready`, `isAuthenticated` (`hasValidAccessToken()`), `claims` (ID token), `accessToken`, `decodedAccessToken`, `roles`, `isAdmin`, `displayName` and `error` (rendered as a banner by the shell).

### Which requests get the token: the interceptor

`angular-oauth2-oidc` registers its bearer interceptor through the class-based `HTTP_INTERCEPTORS` token, and the URL allow-list is only known after `config.json` is loaded. Two providers in [app.config.ts](../apps/angular-app/src/app/app.config.ts) handle both:

```ts
// REQUIRED: plain provideHttpClient() silently skips class-based interceptors
provideHttpClient(withInterceptorsFromDi()),
provideOAuthClient(),
{
  provide: OAuthModuleConfig,
  useFactory: (): OAuthModuleConfig => {
    const config = inject(ConfigService);
    return { resourceServer: { sendAccessToken: true, customUrlValidation: (url) => config.isApiUrl(url) } };
  },
},
```

`isApiUrl()` compares origin and path prefix against `apiUrl` and `graphqlUrl` rather than a bare string prefix, so `http://api.127.0.0.1.nip.io.evil.example/` or another port never receives the token ([config.service.spec.ts](../apps/angular-app/src/app/core/config.service.spec.ts) pins it). The GraphQL page deliberately bypasses `HttpClient`: [graphql.service.ts](../apps/angular-app/src/app/core/graphql.service.ts) sets `Authorization` by hand on a `fetch` call, plus the `Content-Type: application/json` that Apollo's CSRF prevention requires.

### Refresh: refresh tokens, no hidden iframe

Older SPAs renewed tokens in a hidden iframe against the IdP's session cookie; third-party-cookie blocking broke that, and the code flow makes it unnecessary. With `responseType: 'code'` and `useSilentRefresh: false`, `setupAutomaticSilentRefresh()` uses the **refresh_token grant**: it arms on `token_received`, fires `token_expires` after 75 % of the lifetime (`timeoutFactor: 0.75`) and POSTs `grant_type=refresh_token` to the token endpoint. The Profile page's "Refresh token" button calls the same `refreshToken()`; a failure (`token_refresh_error`) surfaces as "Token refresh failed - please sign in again."

### Logout

`logout()` calls `logOut()`: the library removes `access_token`, `id_token`, `refresh_token`, `PKCE_verifier` and `nonce` from storage and redirects to the IdP's `end_session_endpoint` with `id_token_hint` and `post_logout_redirect_uri` (`origin + '/'`), ending the IdP session too. Both in-cluster IdPs publish that endpoint and register `http://angular.127.0.0.1.nip.io/*` as a post-logout URI; without an `end_session_endpoint` the library returns and the router navigates to `/`.

## Roles and guards: UI hints, not authorization

Roles are read from the **access token**, because that is what the APIs authorize on (Keycloak puts realm roles only there by default). [jwt.ts](../apps/angular-app/src/app/core/jwt.ts) implements the rule every app in this repository shares:

```ts
export function extractRoles(claims: unknown, path: string): string[] {
  const value = claimPath(claims, path);           // dotted path, e.g. realm_access.roles
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(' ').filter(Boolean); // like scp / scope
  return [];                                       // missing claim: authenticated, no roles
}
```

`roles()` holds every value found at the path (with Keycloak that includes `offline_access` and `default-roles-k8sgateway`, hence the extra badges in the screenshots); `hasRole('admin')` checks for the configured `roleAdmin` value. The **Admin** link renders only when `isAdmin()` is true, and `/admin` runs `authGuard` then `roleGuard('admin')` ([app.routes.ts](../apps/angular-app/src/app/app.routes.ts)): the first starts the login with the requested URL, the second redirects to `/?denied=admin&from=/admin`.

Sign in as `bob` and open `/admin` by hand: the home page explains which value is missing at which claim path and offers a "Call GET /api/admin/stats anyway" button; the API answers `403 {"error":"forbidden","required_role":"admin"}` regardless of what the UI hid. The [ApiErrorBanner](../apps/angular-app/src/app/shared/api-error.ts) renders 401, 403 and network/CORS errors in plain words.

## A tour of the pages

The header badge names the IdP that was deployed when [e2e/flows.mjs](../e2e/flows.mjs) took the pictures, and the role badges show the raw claim: Keycloak adds its realm roles (`offline_access`, `default-roles-k8sgateway`, `uma_authorization`) beside `admin` and `user`, the mock IdP shows only those two.

![Angular home page signed in as alice: name, subject, role badges, links to the IdP and APIs, and the flow explained in five steps](images/screenshots/angular-home-signed-in.png)

*Home (`/`): who you are, the roles found at `rolesClaim`, links to discovery and the APIs.*

![Angular profile page: ID-token claims table, decoded access token with roles and audience k8sgateway-api, expiry countdown, refresh and copy buttons, raw token and curl command](images/screenshots/angular-profile.png)

*Profile (`/profile`): ID-token claims, the decoded access token with an expiry countdown, a "Refresh token" button (refresh_token grant) and copy buttons for the raw token and a `curl` command.*

![Angular orders page listing orders ord-1 and ord-3 owned by alice with a form to create a new order](images/screenshots/angular-orders.png)

*Orders (`/orders`): `GET` and `POST /api/orders` through `HttpClient`; the interceptor adds the token because the URL is under `apiUrl`. The API requires role `user`.*

![Angular GraphQL page after running the me query: the operation, HTTP 200 and the JSON response with sub, name, preferredUsername, email and roles](images/screenshots/angular-graphql.png)

*GraphQL (`/graphql`): one button per operation plus the `createOrder` mutation, sent with `fetch` and a hand-set bearer header; errors arrive as `extensions.code`.*

`/admin` shows the admin endpoints (role `admin`); `/callback` shows "Signing you in..." during the code exchange. [e2e/flows.mjs](../e2e/flows.mjs) generates the screenshots.

## The nginx image

[Dockerfile](../apps/angular-app/Dockerfile) builds in two stages: `node:22.23.2-alpine` runs `npm ci` and `npm run build` (Angular 22 needs Node 22.22.3+ and TypeScript 6.0.x), then `nginxinc/nginx-unprivileged:1.30.5-alpine` serves `dist/angular-app/browser` as uid 101 on port 8080 with this [nginx.conf](../apps/angular-app/nginx.conf):

| Location | Behavior | Why |
|---|---|---|
| `= /healthz` | `return 200 'ok'`, `access_log off` | probe target without filesystem access |
| `= /config.json` | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` | swapped per IdP; a cached copy would point at the old issuer |
| `= /index.html` | `no-store` | references hashed bundles; must be fresh after every deploy |
| `*.js`, `*.css`, fonts, images | `public, max-age=31536000, immutable` (without `always`) | hashed names never change; a stale-chunk 404 must not be cached for a year |
| `/` | `try_files $uri $uri/ /index.html` | SPA fallback: `/profile` or `/callback?code=...` reach the Angular router |

nginx does not inherit `add_header` into a `location` that defines its own, hence the repetition. Check through the gateway:

```bash
curl -si http://angular.127.0.0.1.nip.io/healthz          # 200 ok
curl -sI http://angular.127.0.0.1.nip.io/config.json      # cache-control: no-store
curl -sI http://angular.127.0.0.1.nip.io/profile          # 200 text/html (fallback)
```

The Deployment sets `runAsNonRoot`, `runAsUser: 101`, drops all capabilities and probes `/healthz`.

## Local development

```bash
cd apps/angular-app
node --version                       # 22.22.3 or newer (nvm use 22, if you use nvm)
npm ci
npm start                            # http://localhost:4200
npm test                             # vitest + jsdom
```

`npm start` works against the mock IdP in the kind cluster unchanged: the redirect URI becomes `http://localhost:4200/callback`, which is registered in [apps/mock-idp/clients.json](../apps/mock-idp/clients.json) and in the Keycloak realm (the mock IdP accepts any redirect URI anyway, `MOCK_ALLOW_ANY_REDIRECT=true`). One limitation: the deployed APIs allow only the two nip.io origins (`CORS_ORIGINS` in `deploy/overlays/*/rest-api.env` and `graphql-api.env`), so API calls from `localhost:4200` show the "API unreachable" banner until you add `http://localhost:4200` there and redeploy. For another IdP, copy a file from [public/config.examples/](../apps/angular-app/public/config.examples/) over it.

## IdP-specific configuration

Only `config.json` changes per IdP. Ready-made files with a `_notes` array: [keycloak.json](../apps/angular-app/public/config.examples/keycloak.json), [entra.json](../apps/angular-app/public/config.examples/entra.json), [oracle.json](../apps/angular-app/public/config.examples/oracle.json); the overlays carry the same values.

| Key | mock IdP | Keycloak | Microsoft Entra ID | Oracle IAM Identity Domains |
|---|---|---|---|---|
| `issuer` | `http://idp.127.0.0.1.nip.io` | `http://keycloak.127.0.0.1.nip.io/realms/k8sgateway` | `https://login.microsoftonline.com/<TENANT_ID>/v2.0` | `https://<DOMAIN_URL>` |
| `scope` | `openid profile email` | `openid profile email` | `openid profile email offline_access api://<API_CLIENT_ID>/access_as_user` | `openid profile email offline_access <resource scope>` |
| `requireHttps` | `false` | `false` | `true` | `true` |
| `strictDiscoveryDocumentValidation` | `true` | `true` | `false` | `false` |
| `skipIssuerCheck` | `false` | `false` | `false` | `true` |
| `rolesClaim` | `roles` | `realm_access.roles` | `roles` | `groups` (verify) |

- **Keycloak**: the `angular-app` client is public with PKCE `S256` enforced, redirect URIs `http://angular.127.0.0.1.nip.io/*` and web origins `+` (CORS for the token POST). Do **not** add `offline_access`: Keycloak issues a normal refresh token anyway, and with that scope it would issue an offline token that never expires and survives logout.
- **Microsoft Entra ID**: register the redirect URI under the *Single-page application* platform, or the token POST fails with a CORS error. Entra accepts `http://` redirect URIs only for `localhost`, so use TLS mode ([chapter 6](06-entra-id.md)) or `npm start` on `http://localhost:4200`. The scope must include your API's scope: with `openid profile email` alone Entra returns a Microsoft Graph token the APIs cannot validate. `offline_access` is required for a refresh token, and refresh tokens issued to SPA redirect URIs expire after 24 hours. Entra's endpoints do not start with the issuer URL, hence `strictDiscoveryDocumentValidation: false`; the tenant-specific issuer passes the issuer check. App roles assigned on the **API** registration appear as `roles` in the access token.
- **Oracle IAM Identity Domains**: create the SPA as a *Mobile Application* (the public client type) and tick *Allow non-HTTPS URLs* for local `http://` testing. The discovery document is fetched from your domain URL but announces `issuer: https://identity.oraclecloud.com/`, hence `skipIssuerCheck: true` and `strictDiscoveryDocumentValidation: false`. Scopes are fully qualified (`<primary audience><scope>`). Oracle does not place groups in the access token by default, so `rolesClaim: "groups"` assumes a custom claim; verify it with a decoded token from your tenant ([chapter 7](07-oracle-iam.md)).

Switching the deployed app between IdPs is `make switch IDP=<idp>` ([chapter 13](13-switching-idps.md)).

## Security notes

- **Tokens in `localStorage`.** The library defaults to `sessionStorage` (per tab, gone when the tab closes). This app provides `localStorage` so the session survives reloads and is shared across tabs, at the price that the access *and refresh* token are readable by any script running on the origin: a cross-site-scripting bug hands out tokens. Keep third-party scripts out, keep Angular's template escaping on, and consider `sessionStorage` or the BFF model of [chapter 9](09-nextjs.md) beyond a demo.
- **The app decodes, the API verifies.** `jwt.ts` never checks signatures, and nothing on the client can be trusted anyway. Every API request is validated again on the server ([chapter 10](10-rest-api-go.md), [chapter 11](11-graphql-api.md)); guards and hidden menu entries are for a tidy UI only.
- **Not a secure context.** `http://*.127.0.0.1.nip.io` is not a secure context, so `crypto.subtle` is unavailable. The library computes the PKCE challenge with its own SHA-256 implementation and the copy buttons fall back to `document.execCommand('copy')` ([clipboard.ts](../apps/angular-app/src/app/core/clipboard.ts)); do not add code that needs `crypto.subtle`. TLS mode removes the limitation ([chapter 14](14-troubleshooting.md)).
- **Debug output.** `showDebugInformation: true` logs complete token responses to the console; leave it off outside a lab.

## Next

[Next.js BFF: tokens never reach the browser](09-nextjs.md)
