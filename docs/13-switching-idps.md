# Switching identity providers

Nothing in the four applications knows which identity provider it talks to. They read a handful of environment variables (or, for Angular, a `config.json`), fetch the provider's discovery document, and validate tokens with rules that hold for every OpenID Connect provider. Switching from the mock IdP to Keycloak, Microsoft Entra ID or Oracle IAM Identity Domains therefore means applying a different set of ConfigMaps and restarting the pods - the container images stay exactly the same. This chapter explains the mechanics behind `make switch IDP=...`, what differs between the four overlays, the two things that bite people after a switch, and how to add a provider of your own.

## What you will learn

- why the applications are IdP-agnostic and which contract makes that possible
- what `scripts/switch-idp.sh`, `scripts/deploy.sh` and `scripts/render.sh` do, step by step
- exactly which values change per IdP (one table for all four overlays)
- the browser-session gotcha and the `SecurityPolicy` issuer gotcha
- how to add a fifth IdP in five steps, and how to use `BASE_DOMAIN`, `SCHEME`, `HTTP_PORT` and `*.local` overlays

## One contract, four providers

![Four IdP cards (mock, Keycloak, Entra ID, Oracle IAM Identity Domains) feeding one ConfigMap per application through make switch; the four application images are unchanged](images/idp-switch.svg)

*Same images, different ConfigMap: the IdP choice is configuration, not code.*

The contract is the table of variables in the [README](../README.md) and [chapter 2](02-architecture.md). Four design decisions make it sufficient for very different providers:

1. **Discovery first.** Every app derives endpoints and the JWKS from `${OIDC_ISSUER}/.well-known/openid-configuration`. Nobody hard-codes an authorize or token URL.
2. **Two escape hatches for non-conforming providers.** `OIDC_ISSUER_CLAIM` is the expected `iss` when it differs from the discovery URL (Oracle advertises the fixed string `https://identity.oraclecloud.com/`), and `OIDC_JWKS_URI` overrides the key location. Both default to "use discovery".
3. **Roles are a path, not a claim name.** `ROLES_CLAIM` is a dotted path into the access token (`roles`, `realm_access.roles`, `groups`); the value may be an array or a space-separated string; a user has role X when the array *contains* `ROLE_X`. Unknown values (Keycloak's `default-roles-k8sgateway`) are ignored, a missing claim means "authenticated, no roles". The implementation is one short function in each API: [apps/rest-api/internal/auth/roles.go](../apps/rest-api/internal/auth/roles.go), [apps/graphql-api/src/auth.ts](../apps/graphql-api/src/auth.ts).
4. **Tolerant where the spec is.** `aud` may be a string (Entra) or an array (everyone else); the frontends take `OIDC_SCOPE` and the BFF's client authentication method (`OIDC_CLIENT_AUTH`) from configuration because providers disagree about both.

Everything else - PKCE, `state`, `nonce`, RS256-only signature checks, the 60 s clock tolerance, the 401/403 error shapes - is identical for every provider and is described in [chapter 1](01-concepts.md).

## What changes: the four overlays

Each directory under [deploy/overlays](../deploy/overlays) is a kustomization that includes `deploy/base` (the four applications, identical everywhere), optionally an in-cluster IdP (`deploy/idp/mock` or `deploy/idp/keycloak`), and one generated ConfigMap per application from a small file: `rest-api.env`, `graphql-api.env`, `nextjs.env`, `angular-config.json`, plus one Secret from `nextjs.secret.env`. The values, side by side:

| | mock | keycloak | entra | oracle |
|---|---|---|---|---|
| in-cluster IdP deployed | `deploy/idp/mock` | `deploy/idp/keycloak` | none | none |
| `OIDC_ISSUER` | `http://idp.127.0.0.1.nip.io` | `http://keycloak.127.0.0.1.nip.io/realms/k8sgateway` | `https://login.microsoftonline.com/<TENANT_ID>/v2.0` | `https://<DOMAIN_URL>` |
| `OIDC_ISSUER_CLAIM` | = issuer | = issuer | = issuer | `https://identity.oraclecloud.com/` (verify with a decoded token) |
| `OIDC_JWKS_URI` | from discovery | from discovery | from discovery | `https://<DOMAIN_URL>/admin/v1/SigningCert/jwk` |
| `OIDC_AUDIENCE` (APIs) | `k8sgateway-api` | `k8sgateway-api` | `<API_CLIENT_ID>` | `https://api.k8sgateway.local/` |
| Angular `clientId` | `angular-app` | `angular-app` | `<ANGULAR_CLIENT_ID>` | `<ANGULAR_CLIENT_ID>` |
| Next.js `OIDC_CLIENT_ID` / secret | `nextjs-app` / `nextjs-secret` | `nextjs-app` / `nextjs-secret` | `<NEXTJS_CLIENT_ID>` / `<NEXTJS_CLIENT_SECRET>` | `<NEXTJS_CLIENT_ID>` / `<NEXTJS_CLIENT_SECRET>` |
| `OIDC_SCOPE` | `openid profile email` | `openid profile email` (never `offline_access`) | `openid profile email offline_access api://<API_CLIENT_ID>/access_as_user` | `openid profile email offline_access https://api.k8sgateway.local/orders.read` |
| `ROLES_CLAIM` | `roles` | `realm_access.roles` | `roles` | `groups` (verify with a decoded token) |
| `OIDC_CLIENT_AUTH` (Next.js) | `client_secret_post` | `client_secret_post` | `client_secret_post` | `client_secret_basic` |
| `OIDC_REQUIRE_HTTPS` / Angular `requireHttps` | `false` | `false` | `true` | `true` |
| Angular `strictDiscoveryDocumentValidation` / `skipIssuerCheck` | `true` / `false` | `true` / `false` | `false` / `false` | `false` / `true` |
| `OIDC_IDP_NAME` / `idpName` | Mock IdP | Keycloak | Microsoft Entra ID | Oracle IAM Identity Domains |

`ROLE_USER=user`, `ROLE_ADMIN=admin`, `API_URL`, `GRAPHQL_URL`, `PUBLIC_URL`, `CORS_ORIGINS` and the in-cluster relay URLs are the same in all four. The `entra` and `oracle` files ship `<PLACEHOLDERS>`; [chapter 6](06-entra-id.md) and [chapter 7](07-oracle-iam.md) explain where each value comes from.

## How a switch works

`make switch IDP=keycloak` runs [scripts/switch-idp.sh](../scripts/switch-idp.sh), which is [scripts/deploy.sh](../scripts/deploy.sh) plus a restart and a few checks. In order:

1. **Prerequisites** (`deploy.sh`): apply `deploy/base/namespaces.yaml`, make sure the empty CA ConfigMap `k8sgateway-ca` exists, and for a `mock*` overlay create the signing-key Secret if it is missing ([chapter 4](04-mock-idp.md)).
2. **Render and apply**: `scripts/render.sh <idp> | kubectl apply -f -`. [scripts/render.sh](../scripts/render.sh) is `kubectl kustomize deploy/overlays/<idp>` with two additions: it refuses to render a file that still contains a `<PLACEHOLDER>`, and it rewrites hostnames when `BASE_DOMAIN`, `SCHEME` or a port differ from the defaults (below).
3. **Hash-driven rollout.** Kustomize's `configMapGenerator` appends a content hash to every generated name and rewrites the references in the Deployments. `rest-api-config-tfm4hbmth9` (mock) becomes `rest-api-config-c48dc2776f` (keycloak), so the pod template changes and Kubernetes rolls the Deployment. This is what makes the Angular config work: `config.json` is mounted with `subPath`, which is never refreshed inside a running container, but a new ConfigMap name means a new pod. Superseded ConfigMaps stay behind (`kubectl apply` does not prune); they are harmless and visible with `kubectl -n k8sgateway get cm -l app.kubernetes.io/part-of=k8sgateway`.
4. **Wait** for the in-cluster IdP (`mock-idp`, or `keycloak` with a 10-minute budget because its first start imports the realm), then for the four Deployments, then until the discovery document answers from your machine.
5. **Restart** (`switch-idp.sh` only): `kubectl -n k8sgateway rollout restart deployment angular-app nextjs-app rest-api graphql-api`. The hash rename already rolled everything whose configuration changed; the explicit restart makes sure every pod re-reads discovery and JWKS at start and picks up a rebuilt image with the same `:dev` tag, and the script then waits until each app answers through the gateway (Envoy learns about new endpoints a moment after the pods are ready).
6. **Checks**: if a `SecurityPolicy` named `rest-api-jwt` exists, compare its issuer with the new IdP's and warn on mismatch; print the browser reminder.

```bash
make switch IDP=keycloak        # scripts/switch-idp.sh keycloak
scripts/urls.sh                 # "IdP currently configured: keycloak" (read from the rest-api ConfigMap)
scripts/test.sh                 # 401/403/200 matrix against the configured IdP
make switch IDP=mock            # back; instant, the mock never stopped
```

The previous in-cluster IdP keeps running so that switching back is instant; remove it with `kubectl delete -k deploy/idp/keycloak` when you are done. `deploy.sh` alone is the right tool for a first deployment or for re-applying the same overlay; `switch-idp.sh` is the right tool whenever pods are already running.

## Gotcha 1: your browser still has a session

After a switch the cluster is consistent, your browser is not. Three things survive:

- **Angular's tokens.** The SPA keeps access, ID and refresh token in `localStorage` (see the comment in [apps/angular-app/src/app/app.config.ts](../apps/angular-app/src/app/app.config.ts)). They were issued by the old IdP, so every API call now fails with `401 invalid_token` (`iss` mismatch), and a silent refresh fails too.
- **Next.js's session cookie.** The encrypted cookie on `next.127.0.0.1.nip.io` still holds the old tokens; `/api/bff/*` relays them and gets the same 401 back.
- **The old IdP's SSO cookie** (`mock_idp_session` on `idp.127.0.0.1.nip.io`, Keycloak's own cookies on `keycloak.127.0.0.1.nip.io`). Harmless now, but if you switch back later you will be signed in without seeing a login page and may wonder which user you are.

The fix is boring: log out in the application *before* switching (both frontends perform RP-initiated logout, which also ends the IdP session), or clear site data for `*.127.0.0.1.nip.io` afterwards. The script prints exactly this reminder at the end. The symptom to recognize is "signed in, but every page shows 401".

![Keycloak login page for the k8sgateway realm](images/screenshots/keycloak-login.png)

*After `make switch IDP=keycloak` the unchanged Angular image sends you here instead of to the mock IdP's page.*

## Gotcha 2: the gateway policy trusts one issuer

The optional `SecurityPolicy` from [chapter 12](12-gateway-jwt.md) validates JWTs in Envoy before they reach the REST API. It cannot use discovery: `issuer` and `remoteJWKS.uri` are literal values in the YAML, one file per IdP in [deploy/gateway-policies](../deploy/gateway-policies). Switch the applications and leave the policy, and the gateway rejects every token from the new IdP with 401 while the API itself would have accepted it. `switch-idp.sh` detects this:

```text
warn SecurityPolicy rest-api-jwt still trusts issuer http://idp.127.0.0.1.nip.io - apply the matching file from deploy/gateway-policies/ or delete the policy
```

Do one of the two:

```bash
kubectl apply -f deploy/gateway-policies/securitypolicy-rest-jwt-keycloak.yaml   # after switching to keycloak
kubectl apply -f deploy/gateway-policies/securitypolicy-rest-jwt.yaml            # after switching back to mock
kubectl -n k8sgateway delete securitypolicy rest-api-jwt                         # or drop edge validation
```

There is no policy file for Entra ID or Oracle IAM Identity Domains; delete the policy or write one with your tenant's issuer and JWKS URL (Envoy can fetch an `https://` JWKS from the cloud).

## Adding a fifth IdP in five steps

Any OpenID Connect provider that issues RS256 JWT access tokens with a roles claim fits the contract - the steps are the same for Auth0, Okta, Amazon Cognito or a second Keycloak.

1. **Register in the provider** what the repository expects: a public SPA client with PKCE and redirect URI `http(s)://angular.<BASE_DOMAIN>/callback`, a confidential web client with redirect URI `http(s)://next.<BASE_DOMAIN>/api/auth/callback`, an API/audience identifier that ends up in `aud`, and a way to put role or group names into the *access* token. Most cloud providers accept only `https://` redirect URIs, so plan on the TLS mode ([deploy/tls/README.md](../deploy/tls/README.md)).
2. **Copy the closest overlay** to a git-ignored `*.local` directory - `entra` if the provider runs outside the cluster:
   ```bash
   cp -r deploy/overlays/entra deploy/overlays/auth0.local
   ```
3. **Fill in the values** in `rest-api.env`, `graphql-api.env`, `nextjs.env`, `nextjs.secret.env` and `angular-config.json`: the exact `issuer` string from the provider's discovery document (compare it with the URL you fetched it from; if they differ, set `OIDC_ISSUER_CLAIM`), `OIDC_AUDIENCE`, the two client ids and the secret, `OIDC_SCOPE`, `OIDC_CLIENT_AUTH` (`client_secret_post` or `client_secret_basic`, whichever the discovery document lists), `OIDC_REQUIRE_HTTPS=true`, and the Angular `strictDiscoveryDocumentValidation`/`skipIssuerCheck` flags (relax them only if the endpoints do not start with the issuer). Decide `ROLES_CLAIM` by decoding a real access token - the mock's `/debug/token` page decodes any JWT. Remove every `<PLACEHOLDER>`, or the render will refuse.
4. **Render, read, switch**:
   ```bash
   scripts/render.sh auth0.local | grep -nE 'OIDC_|"issuer"|rolesClaim'
   SCHEME=https scripts/switch-idp.sh auth0.local     # after make tls
   ```
5. **Verify** by signing in through Angular, copying the access token from its `/profile` page, and calling the API: `curl -H "Authorization: Bearer $TOKEN" https://api.127.0.0.1.nip.io/api/me --cacert deploy/tls/certs/ca.crt` should list your roles; `/api/admin/stats` must return 403 for a user without `admin`.

Three limitations to know. `scripts/get-token.sh` and `scripts/test.sh` only support the in-cluster IdPs (they need the password grant of the `cli` client; `urls.sh` reports the configured IdP as `external`). The dotted-path rule cannot address a claim whose *own name* contains a dot, such as a URL-namespaced custom claim - name the claim without dots or extend the extractor. And the policy files in `deploy/gateway-policies` have no variant for your provider (previous section).

## The render knobs: `BASE_DOMAIN`, `SCHEME`, `HTTP_PORT`

Every hostname in `deploy/` is written literally as `http://<label>.127.0.0.1.nip.io`. When one of these variables differs from its default, `render.sh` copies `deploy/` to a temporary directory, rewrites the URLs with `sed` and renders from there, so the ConfigMap hashes still match their content:

| variable | default | effect |
|---|---|---|
| `BASE_DOMAIN` | `127.0.0.1.nip.io` | replaces the domain in every URL and every HTTPRoute hostname; `scripts/coredns-rewrite.sh` honors it too, but the name must resolve to your machine in the browser (nip.io does that for you; another domain is your DNS problem) |
| `SCHEME` | `http` | `https` in every URL (issuer, `API_URL`, `PUBLIC_URL`, `CORS_ORIGINS`, `KC_HOSTNAME`); needs `make tls` first |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | `8080` / `8443` for rootless Docker or Podman; the port of the active scheme is appended to every URL. Only these two alternatives work, because the Envoy Service exposes 8080/8443 as in-cluster aliases and the kind port mapping is fixed when the cluster is created (`scripts/up.sh`) |
| `PORT_SUFFIX` | derived | explicit override, e.g. `:8080` |

```bash
BASE_DOMAIN=k8s.example.test HTTP_PORT=8080 scripts/render.sh mock | grep -n 'OIDC_ISSUER\|"issuer"'
#   OIDC_ISSUER: http://idp.k8s.example.test:8080
#   "issuer": "http://idp.k8s.example.test:8080",
SCHEME=https scripts/render.sh mock | grep -n 'PUBLIC_URL\|CORS_ORIGINS'
#   PUBLIC_URL: https://next.127.0.0.1.nip.io
#   CORS_ORIGINS: https://angular.127.0.0.1.nip.io,https://next.127.0.0.1.nip.io
```

Pass the same variables to every script that talks to the cluster (`deploy.sh`, `switch-idp.sh`, `test.sh`, `get-token.sh`, `urls.sh`) or export them once; [scripts/lib.sh](../scripts/lib.sh) derives `PORT_SUFFIX` and the URLs from them. The `SecurityPolicy` files are applied as-is, not rendered, so their `issuer` must be edited by hand when the defaults change ([deploy/README.md](../deploy/README.md) shows the `sed`).

## `*.local` overlays for tenant-specific values

Real tenant ids, client ids and secrets do not belong in a public repository. [.gitignore](../.gitignore) excludes `deploy/overlays/*.local/`, and every script accepts such a directory wherever it accepts an overlay name (`deploy.sh entra.local`, `render.sh oracle.local`, `make switch IDP=entra.local`). The placeholder guard tells you what is still missing:

```bash
scripts/render.sh entra
# error overlay "entra" still contains placeholders:
#   .../deploy/overlays/entra/angular-config.json:3: <TENANT_ID>
#   .../deploy/overlays/entra/rest-api.env:5: <API_CLIENT_ID>
#   ...
# Replace them with the values from your tenant (see .../deploy/overlays/entra/README.md), e.g.
#   cp -r .../deploy/overlays/entra .../deploy/overlays/entra.local && sed -i "s/<TENANT_ID>/.../g" .../deploy/overlays/entra.local/*
# and deploy that copy: scripts/deploy.sh entra.local
```

The guard only looks at `*.env` and `*.json` lines outside `#` comments, so comments may keep mentioning placeholders. Because `deploy.sh` decides what to wait for from the *prefix* of the overlay name (`mock*`, `keycloak*`, anything else is external), keep the copy's name starting with the provider it was copied from when it still deploys an in-cluster IdP, for example `keycloak.local`.

## Next

[Troubleshooting](14-troubleshooting.md)
