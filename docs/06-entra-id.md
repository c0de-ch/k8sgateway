# Microsoft Entra ID

Microsoft Entra ID is the first *cloud* identity provider of this tutorial: nothing new runs in the cluster, the applications only get a different ConfigMap. The price is a real tenant with three app registrations, a redirect-URI rule that pushes you into TLS mode (or `localhost`), and a few token details that differ from the mock IdP and Keycloak. This chapter gives the exact portal labels, `az` equivalents where they exist, and the values for [deploy/overlays/entra](../deploy/overlays/entra).

## What you will learn

- Why the API needs its own registration, an Application ID URI and `requestedAccessTokenVersion: 2`
- Registering the Angular SPA (*Single-page application*) and the Next.js BFF (*Web* plus secret); why `http://angular.127.0.0.1.nip.io` is rejected
- How app roles reach the *access* token, and why the ID token's roles differ
- What replaces each overlay placeholder, and deploying in TLS mode
- The v2 token claims; the Graph-token, `offline_access` and `strictDiscoveryDocumentValidation` gotchas
- Entra External ID differences and common `AADSTS` errors

![Switching the IdP is a ConfigMap change; the Entra card shows the tenant issuer, roles claim and scope](images/idp-switch.svg)

*The Entra ID card: tenant-specific v2.0 issuer, `ROLES_CLAIM=roles`, a scope that names the API.*

## How it works

Entra ID models *who calls what* with app registrations. The REST and GraphQL APIs share one, `k8sgateway-api`, which *exposes* a delegated scope and *defines* the app roles `user` and `admin`; the Angular SPA and the Next.js BFF are two more registrations that are *granted* that scope. When a client asks for `api://<API_CLIENT_ID>/access_as_user`, Entra ID issues an access token whose `aud` is the API registration, whose `scp` is `access_as_user`, and whose `roles` lists the app roles the user was assigned **on the API's enterprise application**. The APIs validate it as always ([verifier.go](../apps/rest-api/internal/auth/verifier.go), [auth.ts](../apps/graphql-api/src/auth.ts)), with the tenant's v2.0 URL as issuer and the API's client ID GUID as audience.

Two rules explain most of what follows: **access tokens are shaped by the resource, not the client**, and **redirect URIs must be `https://`, except `http://localhost`** - hence TLS mode ([scripts/tls-setup.sh](../scripts/tls-setup.sh); the how-to is [deploy/tls/README.md](../deploy/tls/README.md) and [section 3](#3-deploy-in-tls-mode) below, the secure-context caveat is in [chapter 14](14-troubleshooting.md#angular-requirehttps-and-secure-context)) or the apps' local dev servers.

## 1. The three app registrations

Create all three under **Entra admin center > Entra ID > App registrations > New registration** (*Single tenant only*). Each Overview page shows the **Application (client) ID** and the **Directory (tenant) ID**. Give every registration an *Owner*, or the API is missing under *API permissions > My APIs*.

| registration | platform | you take away |
|---|---|---|
| `k8sgateway-api` (the resource) | none | `<API_CLIENT_ID>` |
| `k8sgateway-angular` (public client) | Single-page application | `<ANGULAR_CLIENT_ID>` |
| `k8sgateway-nextjs` (confidential client) | Web | `<NEXTJS_CLIENT_ID>`, `<NEXTJS_CLIENT_SECRET>` |

### 1.1 API: `k8sgateway-api`

1. **Expose an API > Application ID URI > Add** (accept `api://<API_CLIENT_ID>`), then **Add a scope**: name `access_as_user`, *Who can consent* = Admins and users. The full scope is `api://<API_CLIENT_ID>/access_as_user`.
2. **App roles > Create app role**, twice: `User` with value `user`, `Admin` with value `admin`, *Allowed member types* = Users/Groups. The **Value** becomes the `roles` claim entry that `ROLE_USER` / `ROLE_ADMIN` match.
3. **Manifest**: set `api.requestedAccessTokenVersion` to `2` (older views call it `accessTokenAcceptedVersion`) and save.

Step 3 is the one people forget: with `null` Entra ID issues **v1.0** access tokens whatever endpoint the client used (the endpoint version only affects the ID token), and the formats validate differently:

| | v1.0 (`ver: "1.0"`) | v2.0 (`ver: "2.0"`) |
|---|---|---|
| `iss` | `https://sts.windows.net/<TENANT_ID>/` | `https://login.microsoftonline.com/<TENANT_ID>/v2.0` |
| `aud` | client ID **or** `api://<API_CLIENT_ID>` | always the client ID GUID |
| client / user claims | `appid`, `upn` | `azp`, `preferred_username` |
| validate against | `.../<TENANT_ID>/.well-known/openid-configuration` | `.../<TENANT_ID>/v2.0/.well-known/openid-configuration` |

The overlay is written for v2; a forgotten switch shows up as `401 issuer mismatch` on every request.

### 1.2 SPA: `k8sgateway-angular`

1. **Authentication > Add a platform > Single-page application.** Redirect URI `https://angular.127.0.0.1.nip.io/callback` (TLS mode) and/or `http://localhost:4200/callback` (local `npm start`). The `spa` platform lets the browser redeem the code cross-origin with PKCE and no secret; a URI registered under *Web* fails with `invalid_request: cross-origin token redemption is permitted only for the 'Single-Page Application' client-type`.
2. **API permissions > Add a permission > My APIs > k8sgateway-api > Delegated > access_as_user**, then **Grant admin consent for \<tenant\>**.

One redirect URI suffices - deep links travel in the OAuth `state` parameter ([auth.service.ts](../apps/angular-app/src/app/core/auth.service.ts)). `http://` is accepted for `localhost` only, and its port is ignored.

### 1.3 Web app: `k8sgateway-nextjs`

1. **Authentication > Add a platform > Web.** Redirect URI `https://next.127.0.0.1.nip.io/api/auth/callback` (and `http://localhost:3000/api/auth/callback` for `npm run dev`). The BFF derives it from `PUBLIC_URL` ([oidc.ts](../apps/nextjs-app/src/lib/oidc.ts)); the two must match byte for byte.
2. **Certificates & secrets > New client secret.** Copy the **Value** now - it is never shown again (24 months maximum; production should use certificates or federated credentials).
3. The same **API permissions** step. The BFF authenticates with `client_secret_post`.

### 1.4 Assign app roles to users

Roles appear in tokens only after assignment: **Enterprise applications > k8sgateway-api > Users and groups > Add user/group > pick the user > Select a role > Assign.** Mirror the demo users: both roles, `User` only, none. Group assignment needs Entra ID P1/P2 and ignores nested groups. Optionally set **Properties > Assignment required? = Yes**: unassigned users then get no token (`AADSTS50105`) and, since user consent is disabled by that setting, admin consent becomes mandatory.

### 1.5 The same with `az` and Microsoft Graph

The CLI has no flag for `spa` redirect URIs or exposed scopes; `az rest` against Microsoft Graph is the verified route for those.

```bash
# roles.json: [{"allowedMemberTypes":["User"],"displayName":"User","value":"user","isEnabled":true,"description":"user"},
#              {"allowedMemberTypes":["User"],"displayName":"Admin","value":"admin","isEnabled":true,"description":"admin"}]
API_APP_ID=$(az ad app create --display-name k8sgateway-api --sign-in-audience AzureADMyOrg --query appId -o tsv)
az ad app update --id "$API_APP_ID" --identifier-uris "api://$API_APP_ID" --requested-access-token-version 2 --app-roles @roles.json
SCOPE_ID=$(python3 -c 'import uuid;print(uuid.uuid4())')
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications(appId='$API_APP_ID')" --headers 'Content-Type=application/json' \
  --body "{\"api\":{\"oauth2PermissionScopes\":[{\"id\":\"$SCOPE_ID\",\"value\":\"access_as_user\",\"type\":\"User\",\"isEnabled\":true,
  \"adminConsentDisplayName\":\"Access k8sgateway API\",\"adminConsentDescription\":\"Call the API as the signed-in user\",
  \"userConsentDisplayName\":\"Access k8sgateway API\",\"userConsentDescription\":\"Call the API on your behalf\"}]}}"
API_SP_ID=$(az ad sp create --id "$API_APP_ID" --query id -o tsv)

SPA_APP_ID=$(az ad app create --display-name k8sgateway-angular --sign-in-audience AzureADMyOrg --query appId -o tsv)
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications(appId='$SPA_APP_ID')" --headers 'Content-Type=application/json' \
  --body '{"spa":{"redirectUris":["https://angular.127.0.0.1.nip.io/callback","http://localhost:4200/callback"]}}'
WEB_APP_ID=$(az ad app create --display-name k8sgateway-nextjs --sign-in-audience AzureADMyOrg \
  --web-redirect-uris https://next.127.0.0.1.nip.io/api/auth/callback --query appId -o tsv)
WEB_SECRET=$(az ad app credential reset --id "$WEB_APP_ID" --display-name dev --years 1 --query password -o tsv)
for APP in "$SPA_APP_ID" "$WEB_APP_ID"; do
  az ad sp create --id "$APP" >/dev/null
  az ad app permission add   --id "$APP" --api "$API_APP_ID" --api-permissions "$SCOPE_ID=Scope"
  az ad app permission grant --id "$APP" --api "$API_APP_ID" --scope access_as_user >/dev/null
done
# Users and groups: POST /servicePrincipals/$API_SP_ID/appRoleAssignedTo {principalId: <user id>, resourceId: $API_SP_ID, appRoleId: <role id>}
```

## 2. Fill in the overlay

[deploy/overlays/entra](../deploy/overlays/entra) renders the base applications plus one ConfigMap per app; no IdP is deployed. Five placeholders appear:

| placeholder | value | files |
|---|---|---|
| `<TENANT_ID>` | Directory (tenant) ID | [rest-api.env](../deploy/overlays/entra/rest-api.env), [graphql-api.env](../deploy/overlays/entra/graphql-api.env), [nextjs.env](../deploy/overlays/entra/nextjs.env), [angular-config.json](../deploy/overlays/entra/angular-config.json) |
| `<API_CLIENT_ID>` | client ID of `k8sgateway-api` - the `aud` of v2 tokens (GUID, not `api://...`) and part of the scope | the same four |
| `<ANGULAR_CLIENT_ID>` | client ID of `k8sgateway-angular` | `angular-config.json` |
| `<NEXTJS_CLIENT_ID>` | client ID of `k8sgateway-nextjs` | `nextjs.env` |
| `<NEXTJS_CLIENT_SECRET>` | the secret's *Value* | [nextjs.secret.env](../deploy/overlays/entra/nextjs.secret.env) |

The rest is pre-filled. The API env files set `OIDC_ISSUER=https://login.microsoftonline.com/<TENANT_ID>/v2.0`, `OIDC_AUDIENCE=<API_CLIENT_ID>` and `ROLES_CLAIM=roles`; no `OIDC_ISSUER_CLAIM` or `OIDC_JWKS_URI`, because the tenant-specific discovery document advertises exactly this issuer and `jwks_uri` `https://login.microsoftonline.com/<TENANT_ID>/discovery/v2.0/keys`. `nextjs.env` adds `OIDC_SCOPE=openid profile email offline_access api://<API_CLIENT_ID>/access_as_user`, `OIDC_CLIENT_AUTH=client_secret_post` and `OIDC_REQUIRE_HTTPS=true` (the BFF ignores `OIDC_AUDIENCE`); `nextjs.secret.env` also holds a demo `SESSION_SECRET` - replace it with `openssl rand -hex 32`. `angular-config.json` sets `requireHttps: true`, `strictDiscoveryDocumentValidation: false`, `skipIssuerCheck: false` and the same scope (see also [config.examples/entra.json](../apps/angular-app/public/config.examples/entra.json)). The `http://` URLs (`API_URL`, `CORS_ORIGINS`, `PUBLIC_URL`, ...) are rewritten by [scripts/render.sh](../scripts/render.sh) under `SCHEME=https`.

Keep tenant values out of the tracked overlay - copy it to a git-ignored `*.local` directory (use a delimiter other than `/` for the secret):

```bash
cp -r deploy/overlays/entra deploy/overlays/entra.local
sed -i 's/<TENANT_ID>/00000000-1111-2222-3333-444444444444/g' deploy/overlays/entra.local/*
sed -i 's/<API_CLIENT_ID>/.../g; s/<ANGULAR_CLIENT_ID>/.../g; s/<NEXTJS_CLIENT_ID>/.../g' deploy/overlays/entra.local/*
sed -i 's|<NEXTJS_CLIENT_SECRET>|paste~the.secret_value|' deploy/overlays/entra.local/nextjs.secret.env
SCHEME=https scripts/render.sh entra.local | grep -E 'OIDC_ISSUER|OIDC_AUDIENCE|"issuer"|PUBLIC_URL'
```

Rendering doubles as a guard: with any `<PLACEHOLDER>` left in an `.env` or `.json` file, `render.sh` - and therefore `deploy.sh` - lists the lines and exits 1 (try `scripts/render.sh entra`).

## 3. Deploy in TLS mode

TLS mode adds an `https` listener with a locally generated CA and publishes the CA to the pods, which keep their system roots for `login.microsoftonline.com` ([deploy/tls/README.md](../deploy/tls/README.md)).

```bash
make tls                                          # scripts/tls-setup.sh: CA, wildcard cert, Secret, https listener
# trust deploy/tls/certs/ca.crt in your browser (table in deploy/tls/README.md)
SCHEME=https scripts/switch-idp.sh entra.local    # render https URLs, apply, restart the four apps
curl --cacert deploy/tls/certs/ca.crt https://api.127.0.0.1.nip.io/readyz
kubectl -n k8sgateway logs deploy/rest-api | grep 'oidc verifier ready'
curl --cacert deploy/tls/certs/ca.crt https://graphql.127.0.0.1.nip.io/readyz
```

`switch-idp.sh` runs `deploy.sh`, restarts the Deployments so every pod re-reads its ConfigMap, and warns if a gateway `SecurityPolicy` from [chapter 12](12-gateway-jwt.md) still trusts another issuer. The REST log line and GraphQL `/readyz` show the discovered issuer and `jwksUri`. Then open `https://angular.127.0.0.1.nip.io` and `https://next.127.0.0.1.nip.io/dashboard` - after clearing the previous IdP's session, as the script reminds you.

[get-token.sh](../scripts/get-token.sh) and [test.sh](../scripts/test.sh) do not apply: they use the password grant of the `cli` client, which only the mock IdP and Keycloak offer. To `curl` with an Entra token, sign in to the Angular app, open **/profile** and press *Copy curl*.

**Without TLS mode**, run the frontends locally: copy `config.examples/entra.json` over `apps/angular-app/public/config.json`, `npm start` there (`http://localhost:4200`) and add `http://localhost:4200` to `CORS_ORIGINS` of both APIs in `entra.local`; for the BFF, `PUBLIC_URL=http://localhost:3000 npm run dev` with the `OIDC_*` variables. The APIs stay in the cluster over plain http - Entra ID only judges the *redirect* URIs.

## 4. What the tokens look like

A v2.0 access token for your API, in the shape Microsoft publishes (`roles` appears once the user is assigned):

| claim | example | meaning |
|---|---|---|
| `aud` | `6e74172b-be56-4843-9ff4-e66a39bb12e3` | the API's client ID - `OIDC_AUDIENCE` |
| `iss` | `https://login.microsoftonline.com/72f988bf-.../v2.0` | tenant issuer - `OIDC_ISSUER` |
| `ver` | `"2.0"` | `"1.0"` means the manifest switch is missing |
| `scp` | `access_as_user` | delegated scopes, space-separated (user tokens only) |
| `roles` | `["admin"]` | app roles on the API - `ROLES_CLAIM` |
| `oid`, `tid` | GUIDs | the user (same in every app of the tenant - the right database key) and the tenant |
| `sub` | opaque | **pairwise**: differs per client registration for the same user |
| `preferred_username`, `name` | `abeli@microsoft.com`, `Abe Lincoln` | display only, mutable - never authorize on them |
| `azp`, `exp` | client ID, epoch seconds | which client asked; lifetime is randomised to 60-90 minutes |

Whether `email` appears without adding the `email` optional claim on the **API** registration is not documented conclusively - verify with a decoded token from your tenant.

The APIs read roles from this token, as do the Angular menu gating ([jwt.ts](../apps/angular-app/src/app/core/jwt.ts)) and the BFF session ([roles.ts](../apps/nextjs-app/src/lib/roles.ts)). The **ID token** may also carry `roles`, but those are app roles defined and assigned *on the SPA or Web registration*; the tutorial defines none there.

![The Angular profile page: ID-token claims and the decoded access token](images/screenshots/angular-profile.png)

*`/profile` against the mock IdP; with Entra ID the decoded access token shows your API's client ID as `aud`, `ver: "2.0"`, `scp` and `roles`.*

### The Microsoft Graph token gotcha

Requesting only `openid profile email` yields an access token for the *UserInfo endpoint*, which is hosted on Microsoft Graph: `aud` `00000003-0000-0000-c000-000000000000`, a `nonce` in the JOSE header, and a signature that does not verify against the tenant's JWKS - Microsoft states only Graph may validate it. Here that is `401 invalid signature` on every request; the cure is the API scope in `OIDC_SCOPE`, never the `sha256(nonce)` header tricks that circulate. For the same reason [auth.service.ts](../apps/angular-app/src/app/core/auth.service.ts) never calls `loadUserProfile()`: Graph rejects a token scoped to your API.

### Refresh tokens: `offline_access` and the 24-hour SPA limit

Entra ID issues a refresh token **only** when `offline_access` is requested - hence its presence in the Entra scope and its absence in the Keycloak profile ([chapter 5](05-keycloak.md)). A refresh token issued to a `spa` redirect URI expires after 24 hours regardless of use; `setupAutomaticSilentRefresh()` works within that window, then the user goes through a (usually silent) top-level login again. Web-app refresh tokens typically last 90 days. Entra tokens are large: when the session cookie would exceed 3.5 KB the BFF moves the ID token to a second cookie, or drops it and skips `id_token_hint` at logout ([session.ts](../apps/nextjs-app/src/lib/session.ts)).

### `strictDiscoveryDocumentValidation: false`

By default angular-oauth2-oidc requires every URL in the discovery document to start with the issuer. Entra's do not - `.../<TENANT_ID>/oauth2/v2.0/authorize`, `.../<TENANT_ID>/discovery/v2.0/keys`, `https://graph.microsoft.com/oidc/userinfo` - so the flag is `false` in the Entra `config.json`. `skipIssuerCheck` stays `false`: the tenant document advertises the exact issuer, and the library must keep checking `iss`. That check is also why `/common` and `/organizations` are out - their metadata advertises a template, and every validator here compares strings:

```bash
curl -s https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration | jq -r .issuer
# https://login.microsoftonline.com/{tenantid}/v2.0
```

### Rehearsing without a tenant

Set `MOCK_FLAVOR=entra` in [deploy/idp/mock/mock-idp.env](../deploy/idp/mock/mock-idp.env) and redeploy the mock overlay: access tokens then carry a string `aud`, `oid`, `tid`, `scp: access_as_user` and `ver: "2.0"` ([flavors.js](../apps/mock-idp/src/flavors.js)); `ROLES_CLAIM` and the audience stay the same ([chapter 4](04-mock-idp.md)).

## 5. Entra External ID (CIAM) in short

An *external* (customer) tenant uses the same three registrations and the same code, but:

- The authority is `https://<tenant-subdomain>.ciamlogin.com/<TENANT_ID>/v2.0`. Microsoft's troubleshooting article prints the `iss` with a trailing `/`; read the exact `issuer` from your tenant's discovery document before setting `OIDC_ISSUER` - the validators compare byte for byte.
- Registrations are single-tenant only; only Microsoft Graph `openid`, `offline_access`, `User.Read` and your *My APIs* are permitted; customers cannot consent, so an admin must **Grant admin consent**.
- The API still needs `requestedAccessTokenVersion: 2`; otherwise you get the documented `IDX20804: Unable to retrieve document from .../common/discovery/keys`.
- Each application must be attached to a sign-up/sign-in **user flow** (*External Identities > User flows > flow > Applications > Add application*).
- App roles work the same; group claims are object IDs only, group-to-role assignments are Graph-only, the password grant is unsupported.

## 6. Troubleshooting

| symptom | cause and fix |
|---|---|
| `AADSTS50011` reply address doesn't match | redirect URI not registered exactly (scheme, host, path, case); check `PUBLIC_URL` and `SCHEME=https` |
| `AADSTS65001` hasn't consented | no granted `access_as_user` permission on the client: add it, grant admin consent |
| `AADSTS700016` application not found in the directory | wrong client ID, or wrong `<TENANT_ID>` in the issuer |
| `AADSTS50194` not configured as multitenant | you used `/common`; use the tenant issuer |
| `AADSTS70011` invalid scope, `AADSTS500011` resource principal not found, `AADSTS650057` invalid resource | typo in the `api://...` scope, no service principal for the API (`az ad sp create`), or permission missing on the client |
| `AADSTS50105` user isn't assigned to a role | *Assignment required* is on and the user has no assignment on `k8sgateway-api` |
| `AADSTS7000215` / `AADSTS7000222` / `AADSTS7000218` | invalid / expired / missing client secret (`nextjs.secret.env`, or `OIDC_CLIENT_AUTH=none`) |
| `invalid_request: cross-origin token redemption is permitted only for the 'Single-Page Application' client-type` (no `AADSTS` number in the reference) | the Angular redirect URI is registered under *Web*; move it to the SPA platform |
| APIs answer `401` for every token | `issuer mismatch`: v1 token, set `requestedAccessTokenVersion: 2`. `invalid signature`: Graph token, the API scope is missing from `OIDC_SCOPE` / `config.json`. `audience mismatch`: `OIDC_AUDIENCE` must be the GUID |
| `200` but `roles: []` on `/api/me` | user not assigned on the API's enterprise application, or roles defined on the SPA registration |
| Angular logs `discovery_document_validation_error` | `strictDiscoveryDocumentValidation` is not `false` in the mounted `config.json` |

The `AADSTS` codes and their descriptions are paraphrased from Microsoft's [error-code reference](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes), where all eleven codes above are listed; the remedies in the right column are this project's.

## Next

[Oracle IAM Identity Domains](07-oracle-iam.md)
