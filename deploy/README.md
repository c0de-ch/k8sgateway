# deploy/ - Kubernetes manifests

Everything here is plain YAML rendered with `kubectl kustomize` (no Helm, no
templating language). The shape:

```
deploy/
├── kind/kind-config.yaml        kind cluster: host 80/443 -> NodePorts 30080/30443
├── gateway/                     GatewayClass "eg", EnvoyProxy (NodePort), Gateway "main"
├── base/                        the four applications (identical for every IdP)
│   ├── namespaces.yaml          k8sgateway + idp
│   └── <app>/                   deployment.yaml, service.yaml, httproute.yaml
├── idp/
│   ├── mock/                    mock IdP (apps/mock-idp) + users.json + env
│   └── keycloak/                Keycloak 26 dev mode + realm-export.json
├── overlays/
│   ├── mock/                    base + idp/mock   + per-app config for the mock IdP
│   ├── keycloak/                base + idp/keycloak + per-app config for Keycloak
│   ├── entra/                   base + per-app config for Entra ID (placeholders)
│   └── oracle/                  base + per-app config for Oracle IAM (placeholders)
├── gateway-policies/            optional SecurityPolicy examples (JWT at the edge)
└── tls/                         optional https listener (scripts/tls-setup.sh)
```

## How an overlay is rendered

`scripts/render.sh <overlay>` is `kubectl kustomize deploy/overlays/<overlay>`
plus two conveniences:

1. **Placeholder guard** - the `entra` and `oracle` overlays ship
   `<TENANT_ID>`-style values. Rendering (and therefore `scripts/deploy.sh`)
   refuses to continue until they are replaced; copy the directory to
   `deploy/overlays/<name>.local` (git-ignored) and fill in your values.
2. **Hostname rewrite** - every hostname is written literally as
   `*.127.0.0.1.nip.io` with `http://`. When `BASE_DOMAIN`, `SCHEME` or
   `PORT_SUFFIX` differ from the defaults, the script copies `deploy/` to a
   temporary directory, rewrites the URLs with `sed` and renders from there.
   Doing the rewrite *before* kustomize keeps the generated ConfigMap hashes
   consistent with their content.

Each overlay generates one ConfigMap per application from a small env file
(`rest-api.env`, `graphql-api.env`, `nextjs.env`, `angular-config.json`) and
one Secret for the confidential Next.js client (`nextjs.secret.env`). The base
Deployments reference them by their plain name (`envFrom: configMapRef:
rest-api-config`); kustomize appends a content hash (`rest-api-config-tfm4h…`)
and rewrites the references. Because the name changes whenever the content
changes, applying a different overlay automatically rolls the Deployments -
important for the Angular ConfigMap, which is mounted with `subPath` and would
otherwise never be refreshed inside a running pod. Superseded ConfigMaps are
left behind (kubectl apply does not prune); they are tiny, and
`kubectl -n k8sgateway get cm -l app.kubernetes.io/part-of=k8sgateway` shows
them next to the ones the Deployments currently reference.

The variable names are the same in every application (OIDC contract in the
[README](../README.md)); only the values differ per IdP:

| variable | mock | keycloak | entra | oracle |
|----------|------|----------|-------|--------|
| `OIDC_ISSUER` | `http://idp.127.0.0.1.nip.io` | `http://keycloak.127.0.0.1.nip.io/realms/k8sgateway` | `https://login.microsoftonline.com/<TENANT_ID>/v2.0` | `https://<DOMAIN_URL>` |
| `OIDC_ISSUER_CLAIM` | = issuer | = issuer | = issuer | `https://identity.oraclecloud.com/` |
| `OIDC_JWKS_URI` | from discovery | from discovery | from discovery | `https://<DOMAIN_URL>/admin/v1/SigningCert/jwk` |
| `OIDC_AUDIENCE` | `k8sgateway-api` | `k8sgateway-api` | `<API_CLIENT_ID>` | `https://api.k8sgateway.local/` |
| `ROLES_CLAIM` | `roles` | `realm_access.roles` | `roles` | `groups` (verify) |
| `OIDC_CLIENT_AUTH` (Next.js) | `client_secret_post` | `client_secret_post` | `client_secret_post` | `client_secret_basic` |
| `OIDC_REQUIRE_HTTPS` | `false` | `false` | `true` | `true` |

## The CoreDNS trick

Browsers reach the cluster through `http://<name>.127.0.0.1.nip.io`: nip.io
resolves that to 127.0.0.1, kind forwards host port 80 to NodePort 30080, and
the Envoy proxy Service listens there. Inside a pod, however, 127.0.0.1 is the
pod's own loopback, so a pod fetching `http://idp.127.0.0.1.nip.io/.well-known/openid-configuration`
would talk to itself.

`scripts/coredns-rewrite.sh` (run by `scripts/up.sh`) patches the CoreDNS
Corefile with

```
rewrite stop {
    name regex ^(.*)\.127\.0\.0\.1\.nip\.io\.$ envoy-k8sgateway-main-<hash>.envoy-gateway-system.svc.cluster.local
    answer auto
}
```

so that inside the cluster every `*.127.0.0.1.nip.io` name resolves to the
Envoy Service. Envoy still sees the original `Host` header and routes as usual.
The result: the **same issuer URL** is valid in the browser (Angular, redirects)
and in the pods (REST/GraphQL fetching JWKS, Next.js exchanging codes), which is
exactly what OIDC requires - the `iss` claim must match wherever the token is
validated. `answer auto` rewrites the response name back to the query name;
without it strict resolvers (glibc, Java) discard the answer. The regex is
anchored because pods search `ndots:5` suffixes.

Kubernetes Service DNS names (`http://rest-api.k8sgateway.svc.cluster.local:8080`)
are still used for pod-to-pod calls that do not have to match a token claim,
e.g. the GraphQL API relaying a bearer token to the REST API, or Envoy fetching
the JWKS in the SecurityPolicy examples.

## Identity providers

### mock (default)

`idp/mock` runs `apps/mock-idp` with `users.json` (same demo users as the
Keycloak realm) and `mock-idp.env`. Change `MOCK_FLAVOR` to `keycloak`, `entra`
or `oracle` to have it imitate the claim shapes of those products (combine with
the matching `ROLES_CLAIM` in the overlay) - handy for developing against a
cloud IdP without touching the tenant.

Its RS256 signing key comes from the Secret `idp/mock-idp-key`, which
`scripts/deploy.sh` generates once with `openssl genpkey` and the Deployment
mounts at `/keys/key.pem` (`MOCK_KEY_FILE`). Without it every restart would
rotate the key: tokens issued before the restart become invalid and anything
that cached the JWKS (the APIs, a gateway `SecurityPolicy`) answers 401 until
its cache expires. The volume is `optional`, so a plain `kubectl apply -k
deploy/overlays/mock` still works - with an ephemeral key.

### keycloak

`idp/keycloak` starts `quay.io/keycloak/keycloak:26.7.4` with
`start-dev --import-realm`. Things worth knowing about `realm-export.json`:

- The realm has two roles (`user`, `admin`), the users alice/bob/carol, and the
  clients `angular-app` (public, PKCE S256 required), `nextjs-app`
  (confidential), `cli` (password grant for scripts) and `svc-batch`
  (client credentials; its service-account user carries the `admin` role).
- Access tokens get `aud: k8sgateway-api` through the client scope
  `k8sgateway-api` (an *Audience* mapper) which is a realm default scope, so
  every client has it. Keycloak does not add the API audience on its own.
- Realm roles appear in the access token as `realm_access.roles`, together with
  Keycloak's automatic roles (`default-roles-k8sgateway`, `offline_access`,
  `uma_authorization`). Applications look for their own role names and ignore
  the rest.
- The frontends request `openid profile email` - **not** `offline_access`.
  Keycloak returns a normal refresh token (30 min idle, tied to the SSO
  session) without it; *with* it the refresh token becomes an *offline token*
  that never expires and survives logout, which is not what a web application
  wants. (The mock IdP hands out a refresh token for every code grant either
  way; the Entra and Oracle overlays do request `offline_access` because those
  providers require it for refresh tokens.)
- Two import quirks are handled in the file: a realm file that defines
  `clientScopes` suppresses the creation of the built-in scopes (`profile`,
  `email`, `roles`, `basic`, ...) unless the realm attribute
  `CreateDefaultClientScopes=true` is present; and imported users are not given
  the realm default role automatically, so `default-roles-k8sgateway` is listed
  explicitly for each user - it is the composite Keycloak assigns to every user
  created through the console (account-console roles, `uma_authorization`) and
  keeps the demo users identical to hand-made ones.
- Redirect URIs are exact where the client has a single callback
  (`nextjs-app`: `http(s)://next.127.0.0.1.nip.io/api/auth/callback`) and a
  wildcard for the SPA, whose callback is `/callback` but which also returns to
  deep links.
- `KC_HOSTNAME=http://keycloak.127.0.0.1.nip.io` fixes the issuer for browsers
  and pods alike; health probes use the management port 9000; the H2 database
  is ephemeral, so every restart re-imports the realm (admin-console changes are
  lost - edit the JSON instead). Admin console: `/admin/`, user `admin`,
  password `admin`.
- Dev-only settings, never for production: the bootstrap admin `admin/admin`,
  `start-dev`, `sslRequired: none`, and `KC_HOSTNAME_DEBUG=true`, which exposes
  `GET /realms/k8sgateway/hostname-debug` (and the HTTPRoute publishes the whole
  server, `/admin/` included, through the gateway).

### entra / oracle

No in-cluster IdP; the overlays only carry configuration. See the README in
each overlay directory for the app registrations and the placeholders.

## Gateway policies (optional)

`gateway-policies/` shows Envoy Gateway's `SecurityPolicy` validating JWTs at
the edge before a request reaches the REST API - defense in depth, the API
validates again. Three variants share the name `rest-api-jwt`, so applying one
replaces the previous:

```bash
kubectl apply -f deploy/gateway-policies/securitypolicy-rest-jwt.yaml          # mock IdP, JWT only
kubectl apply -f deploy/gateway-policies/securitypolicy-rest-jwt-keycloak.yaml # Keycloak issuer/JWKS
kubectl apply -f deploy/gateway-policies/securitypolicy-rest-authz.yaml        # + admin role for /api/admin
kubectl delete securitypolicy -n k8sgateway rest-api-jwt                       # back to app-only validation
```

With a policy applied, `GET /api/public` without a token is rejected by the
gateway (401), and `scripts/test.sh` reports that check as failed - expected.

The policies are applied as-is, not through `scripts/render.sh`: their `issuer`
is the literal default. With a different `BASE_DOMAIN`, `SCHEME` or host port,
rewrite it first, e.g. `sed 's#http://idp.127.0.0.1.nip.io#http://idp.127.0.0.1.nip.io:8080#' deploy/gateway-policies/securitypolicy-rest-jwt.yaml | kubectl apply -f -`.

## Host ports 80/443 not available

Rootless Docker and Podman cannot bind ports below 1024 by default. Either
allow it once (`sudo sysctl net.ipv4.ip_unprivileged_port_start=80`) or create
the cluster with other host ports:

```bash
HTTP_PORT=8080 HTTPS_PORT=8443 scripts/up.sh
```

What changes: `scripts/up.sh` writes a copy of `kind/kind-config.yaml` with
`hostPort: 8080/8443` (the NodePorts 30080/30443 inside stay the same),
`scripts/lib.sh` derives `PORT_SUFFIX=:8080` from `HTTP_PORT` (or `:8443` from
`HTTPS_PORT` when `SCHEME=https`), and `scripts/render.sh` appends that suffix
to **every** URL in the manifests - the issuer included, because the browser must
be able to open it and the `iss` claim must match what the pods expect. Pods
resolve `*.127.0.0.1.nip.io` to the Envoy Service, so that Service has to answer
on the same port: `gateway/envoyproxy.yaml` adds port 8080 (and `tls/gateway-https.yaml`
port 8443) as in-cluster aliases of the listeners, which is why only these two
alternative ports are supported. Envoy ignores the port in the `Host` header
when matching routes. Keep passing `HTTP_PORT`/`HTTPS_PORT` (or `PORT_SUFFIX`)
to the other scripts - `deploy.sh`, `switch-idp.sh`, `test.sh`, `get-token.sh`,
`urls.sh` - so they render and print the right URLs.

## TLS (optional)

`tls/` adds an https listener with a locally generated CA; see
[tls/README.md](tls/README.md).

## Ingress mode (deploy/ingress)

`scripts/ingress-mode.sh on` deletes the Gateway, installs Traefik v3 as a classic Ingress controller (same NodePorts 30080/30443) and applies one `Ingress` per hostname; `off` reverses it. The applications and IdPs are untouched. See docs/16-ingress.md.
