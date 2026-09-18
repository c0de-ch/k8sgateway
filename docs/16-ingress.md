# Ingress instead of the Gateway API

Everything in this tutorial runs behind the Kubernetes Gateway API (Envoy Gateway). Many clusters still route traffic with a classic **Ingress controller**, and nothing about OpenID Connect or JWT validation depends on which of the two you use. This chapter swaps the Gateway for Traefik v3 acting as a plain Ingress controller, routes the same six hostnames with one `Ingress` each, and walks through the complete example again: browser logins, per-user tokens with curl, the automated checks. The applications, the identity providers and their configuration are not touched.

## What you will learn

- what the Ingress API can and cannot express compared to the Gateway API, and why this repository defaults to the Gateway API
- the exact resources that change (`Ingress`, `IngressClass`, the controller) and the ones that do not (apps, IdPs, overlays, issuer URLs)
- how `make ingress-on` / `make ingress-off` switch between the two on the running kind cluster
- the full example through the Ingress: Angular and Next.js logins, the OAuth 2.0-only per-user token example with curl, GraphQL, `make test`, the browser suite
- where JWT validation happens when the edge has no `SecurityPolicy`, and what an external-authorization hop looks like

## Ingress and Gateway API in two minutes

| | Ingress (`networking.k8s.io/v1`) | Gateway API (`gateway.networking.k8s.io/v1`) |
|---|---|---|
| Model | one resource per application: host and path rules pointing at Services | roles split into `GatewayClass` (infrastructure), `Gateway` (listeners) and `HTTPRoute` (application routing) |
| Portable features | host/path matching, TLS termination with a Secret, a default backend | matching on headers, methods and query strings, weighted backends, redirects, rewrites, header modification, cross-namespace routes |
| Everything else | controller-specific annotations (`nginx.ingress.kubernetes.io/...`, `traefik.ingress.kubernetes.io/...`) | typed policy resources, for Envoy Gateway the `SecurityPolicy` used in [chapter 12](12-gateway-jwt.md) for JWT validation, CORS and authorization |
| Status in 2026 | stable and frozen; ingress-nginx, the most common controller, was archived in March 2026 (last release `controller-v1.15.1`); Traefik, Contour, HAProxy, Cilium and cloud controllers still support it | the successor; every major data plane ships an implementation, Envoy Gateway v1.9.1 here |

This repository defaults to the Gateway API because it is where new work happens and because a portable `SecurityPolicy` lets you show JWT enforcement at the edge. The Ingress variant exists because the OIDC part of the tutorial is identical behind either, and because a cluster that already has an Ingress controller should not need a second data plane to try the examples.

## What changes and what does not

| Gateway mode ([deploy/gateway](../deploy/gateway)) | Ingress mode ([deploy/ingress](../deploy/ingress)) |
|---|---|
| `GatewayClass eg` + Envoy Gateway controller | `IngressClass traefik` + the Traefik Deployment in namespace `ingress` |
| `EnvoyProxy` patch pinning NodePorts 30080/30443 | the Traefik `Service` with the same `nodePort` values, so [deploy/kind/kind-config.yaml](../deploy/kind/kind-config.yaml) (host 80/443) is unchanged |
| `Gateway main` with an `http` listener | Traefik entrypoint `web` on container port 8000, Service port 80 |
| six `HTTPRoute`s with `hostnames` and `parentRefs` | six `Ingress` resources with `rules[].host` and `ingressClassName: traefik` |
| `SecurityPolicy` (JWT, CORS, authorization at the edge) | no equivalent in the Ingress API; see [JWT validation without a gateway policy](#jwt-validation-without-a-gateway-policy) |
| CoreDNS rewrite `*.127.0.0.1.nip.io` -> Envoy proxy Service | the same rewrite -> `traefik.ingress.svc.cluster.local` |

Unchanged: the five application images, the ConfigMaps rendered from `deploy/overlays/*`, the issuer URLs (`http://idp.127.0.0.1.nip.io`, `http://keycloak.127.0.0.1.nip.io/realms/k8sgateway`), the redirect URIs registered at the IdPs, the tokens and everything the APIs check. Because the browser and the pods keep using the same hostnames, a token issued while the Gateway was active stays valid after the switch.

## The manifests

[deploy/ingress/traefik.yaml](../deploy/ingress/traefik.yaml) is a minimal, CRD-free Traefik installation: a namespace, a ServiceAccount with a ClusterRole that may read Services, EndpointSlices, Secrets, Ingresses and IngressClasses, the `IngressClass`, one Deployment and a NodePort Service. The arguments that matter:

```yaml
args:
  - --entrypoints.web.address=:8000        # plain http, Service port 80
  - --entrypoints.websecure.address=:8443  # https, Service port 443 (needs a TLS secret per Ingress)
  - --entrypoints.traefik.address=:9000    # ping / health only, not exposed
  - --ping=true
  - --ping.entrypoint=traefik
  - --providers.kubernetesingress=true
  - --providers.kubernetesingress.ingressclass=traefik
  - --providers.kubernetesingress.ingressendpoint.publishedservice=ingress/traefik
  - --accesslog=true
```

Only the Kubernetes *Ingress* provider is enabled: no Traefik CRDs, no dashboard, no Gateway API provider. The container runs as user 65532 on unprivileged ports, which is why the Service maps 80 to 8000 and 443 to 8443.

[deploy/ingress/ingresses.yaml](../deploy/ingress/ingresses.yaml) holds one `Ingress` per hostname. This is the REST API's; the other five differ only in name, namespace, host and Service:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rest-api
  namespace: k8sgateway
spec:
  ingressClassName: traefik
  rules:
    - host: api.127.0.0.1.nip.io
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: rest-api
                port:
                  number: 8080
```

Compare it with [deploy/base/rest-api/httproute.yaml](../deploy/base/rest-api/httproute.yaml): `hostnames` became `rules[].host`, `backendRefs` became `backend.service`, and `parentRefs` (which Gateway to attach to) became `ingressClassName` (which controller owns the resource). The `mock-idp` and `keycloak` Ingresses live in namespace `idp`; an Ingress whose Service does not exist yet (Keycloak before `make switch IDP=keycloak`) is harmless, Traefik just answers 404 for that host until the Service appears.

## Switching

```bash
make ingress-on      # = scripts/ingress-mode.sh on
make ingress-off     # = scripts/ingress-mode.sh off
scripts/ingress-mode.sh status
```

[scripts/ingress-mode.sh](../scripts/ingress-mode.sh) `on` does four things, in this order:

1. deletes `Gateway k8sgateway/main` and waits until Envoy Gateway has removed the proxy Deployment and Service - both data planes want NodePorts 30080/30443, so only one can exist;
2. applies `deploy/ingress` (through the same hostname rewrite as `scripts/render.sh`, so `BASE_DOMAIN` works here too) and waits for the Traefik rollout;
3. re-runs [scripts/coredns-rewrite.sh](../scripts/coredns-rewrite.sh) with `REWRITE_TARGET=traefik.ingress.svc.cluster.local`, so pods resolving `*.127.0.0.1.nip.io` now land on Traefik; without this step the APIs could no longer fetch the IdP's discovery document and JWKS ([chapter 2](02-architecture.md) explains the trick);
4. waits until `http://api.127.0.0.1.nip.io/api/public` answers through Traefik and prints the Ingress table:

```text
==> deleting Gateway k8sgateway/main (frees NodePorts 30080/30443)
==> installing Traefik and the Ingress resources (deploy/ingress)
deployment "traefik" successfully rolled out
==> pointing *.127.0.0.1.nip.io inside the cluster at the Traefik Service
CoreDNS: *.127.0.0.1.nip.io -> traefik.ingress.svc.cluster.local
==> waiting for the applications to answer through the Ingress
NAMESPACE    NAME          CLASS     HOSTS                       ADDRESS   PORTS   AGE
idp          keycloak      traefik   keycloak.127.0.0.1.nip.io             80      6s
idp          mock-idp      traefik   idp.127.0.0.1.nip.io                  80      6s
k8sgateway   angular-app   traefik   angular.127.0.0.1.nip.io              80      6s
k8sgateway   graphql-api   traefik   graphql.127.0.0.1.nip.io              80      6s
k8sgateway   nextjs-app    traefik   next.127.0.0.1.nip.io                 80      6s
k8sgateway   rest-api      traefik   api.127.0.0.1.nip.io                  80      6s
 ok  Ingress mode active - the URLs are unchanged: http://angular.127.0.0.1.nip.io, ...
```

`off` reverses it: removes Traefik and the Ingresses, re-applies `deploy/gateway` (and the https listener if [TLS mode](../deploy/tls/README.md) was set up), waits for `Programmed` and points the DNS rewrite back at the Envoy proxy Service. `scripts/up.sh` refuses to run while Ingress mode is active, because it would try to re-create the Gateway on the occupied NodePorts; `scripts/deploy.sh` and `scripts/switch-idp.sh` work in both modes, they only touch the applications and IdPs.

## The full example through the Ingress

Nothing below is new; it is the walk-through of [chapter 3](03-quickstart.md) repeated to show that the routing layer is not part of the security story.

### 1. Browser logins

Open <http://angular.127.0.0.1.nip.io> and sign in as `alice` (password `alice`). The redirect to the IdP, the callback with `code` and `state`, the PKCE exchange and the bearer calls to `api.127.0.0.1.nip.io` and `graphql.127.0.0.1.nip.io` all pass through Traefik now; the access log in `kubectl -n ingress logs deploy/traefik` shows every hop with the router that matched, for example `k8sgateway-rest-api-api-127-0-0-1-nip-io@kubernetes`. <http://next.127.0.0.1.nip.io> works the same way: the BFF's server-side calls to the REST and GraphQL APIs go directly to the Services, only its calls to the IdP (discovery, token endpoint) go through the Ingress via the DNS rewrite.

### 2. Per-user tokens with curl (OAuth 2.0 only)

[scripts/get-token.sh](../scripts/get-token.sh) obtains a token for a demo user with the Resource Owner Password Credentials grant on the test client `cli`. Keep in mind what [chapter 1](01-concepts.md#the-per-user-token-example-is-oauth-20-only) says: this grant is **OAuth 2.0 only**, OAuth 2.1 removes it, and no application in this repository uses it; it exists so that a terminal can show the 200/401/403 matrix. Captured with Keycloak as the active IdP and Traefik in front:

```bash
TOKEN=$(scripts/get-token.sh alice)
curl -si -H "Authorization: Bearer $TOKEN" http://api.127.0.0.1.nip.io/api/me
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Vary: Origin

{"claims":{"acr":"1","aud":["k8sgateway-api","account"],"azp":"cli","email":"alice@example.com",
 "iss":"http://keycloak.127.0.0.1.nip.io/realms/k8sgateway","preferred_username":"alice",
 "realm_access":{"roles":["offline_access","admin","default-roles-k8sgateway","uma_authorization","user"]},
 "scope":"openid email profile","sub":"1bfd3a68-25c7-4659-9c0d-c9629f184e9b","typ":"Bearer", ...},
 "email":"alice@example.com","name":"Alice Admin","preferred_username":"alice","roles":["admin","user"],
 "sub":"1bfd3a68-25c7-4659-9c0d-c9629f184e9b"}
```

The `iss` is still the Keycloak realm URL and `aud` still contains `k8sgateway-api`: the token does not know or care which proxy carried it. Without a token, and as `bob` on an admin route:

```bash
curl -si http://api.127.0.0.1.nip.io/api/me | head -6
TOKEN=$(scripts/get-token.sh bob)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" http://api.127.0.0.1.nip.io/api/admin/stats
```

```text
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Www-Authenticate: Bearer realm="k8sgateway-api"

403
```

Both answers come from the REST API itself ([chapter 10](10-rest-api-go.md)). With the Gateway and the `SecurityPolicy` of chapter 12 applied, the 401 would come from Envoy instead (`Jwt is missing`); an Ingress controller has no such filter, so the application is the only place that says no.

### 3. GraphQL

```bash
TOKEN=$(scripts/get-token.sh alice)
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{ me { preferredUsername roles } }"}' http://graphql.127.0.0.1.nip.io/graphql
```

```json
{"data":{"me":{"preferredUsername":"alice","roles":["offline_access","admin","default-roles-k8sgateway","uma_authorization","user"]}}}
```

The `roles` list is Keycloak's raw `realm_access.roles`; the API maps it to `user`/`admin` with `ROLE_USER`/`ROLE_ADMIN` and ignores the rest ([chapter 5](05-keycloak.md)).

### 4. The automated checks

```bash
make test                       # 18 passed, 0 failed - same as in Gateway mode
cd e2e && IDP=keycloak npm test # all browser checks passed
```

`scripts/test.sh` and the Playwright suite only use URLs, so they run unchanged; both were green through Traefik with the mock IdP and with Keycloak while this chapter was written.

### 5. Inside the pods

```bash
kubectl -n idp exec deploy/mock-idp -- nslookup api.127.0.0.1.nip.io
```

```text
Address: 10.96.150.225        # the ClusterIP of Service ingress/traefik
```

That is the whole DNS trick in one line: the pods talk to the same hostnames as the browser, and CoreDNS decides which data plane answers.

## Keycloak behind an Ingress

Keycloak needs to know the scheme and host the user typed, otherwise its redirects and the issuer would show pod-internal values. The realm deployment already pins `KC_HOSTNAME=http://keycloak.127.0.0.1.nip.io` and sets `KC_PROXY_HEADERS=xforwarded` ([chapter 5](05-keycloak.md)); Traefik forwards `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` by default (`http://keycloak.127.0.0.1.nip.io/realms/k8sgateway/hostname-debug` lists them), as does ingress-nginx. Nothing to change. The same holds for the Next.js BFF, which derives every redirect URI from `PUBLIC_URL` rather than from request headers.

## JWT validation without a gateway policy

With the Gateway API, [chapter 12](12-gateway-jwt.md) validates tokens at the edge with a `SecurityPolicy` *in addition to* the applications. The Ingress API has no portable equivalent, which leaves two options:

1. **The applications validate, full stop.** This is what the repository does anyway: the Go REST API and the GraphQL API check signature, `iss`, `aud`, `exp` and roles on every request. An edge filter is defence in depth, not the primary control, so removing it changes nothing about who gets a 200.
2. **An external-authorization hop.** Both common controllers can ask another HTTP service before forwarding a request and pass the original `Authorization` header along. The verifier answers 2xx to allow or 401/403 to deny. Neither snippet is applied by the scripts; they show the shape:

   ingress-nginx (`auth-url` annotation on the protected Ingress):

   ```yaml
   metadata:
     annotations:
       nginx.ingress.kubernetes.io/auth-url: "http://jwt-verifier.k8sgateway.svc.cluster.local:8080/verify"
       nginx.ingress.kubernetes.io/auth-response-headers: "X-User-Sub, X-User-Roles"
   ```

   Traefik (a `ForwardAuth` middleware, which needs the Traefik CRDs that `deploy/ingress` deliberately does not install, referenced from the Ingress):

   ```yaml
   apiVersion: traefik.io/v1alpha1
   kind: Middleware
   metadata:
     name: jwt-verifier
     namespace: k8sgateway
   spec:
     forwardAuth:
       address: http://jwt-verifier.k8sgateway.svc.cluster.local:8080/verify
       authResponseHeaders: [X-User-Sub, X-User-Roles]
   ---
   # on the Ingress:
   #   traefik.ingress.kubernetes.io/router.middlewares: k8sgateway-jwt-verifier@kubernetescrd
   ```

   The verifier is a tiny resource server of its own - the validation code of [chapter 10](10-rest-api-go.md) with a single `/verify` route would do; it must see the `Authorization` header (both controllers forward it), and the protected backends must then trust the `X-User-*` headers only from the controller, typically enforced with a NetworkPolicy. Compared to a `SecurityPolicy` this is an extra hop, an extra deployment and controller-specific configuration, which is the practical reason the Gateway API is the better fit for edge JWT validation.

## TLS and non-default ports

Ingress TLS is per resource: add `spec.tls[].hosts` and `secretName` to an Ingress and put the Secret in the Ingress's namespace (so twice here, `k8sgateway` and `idp`). The [TLS mode script](../deploy/tls/README.md) targets the Gateway and does not do this; Ingress mode is plain http by design. `HTTP_PORT=8080` installations work unchanged: the NodePorts are the same, only the host side of the kind port mapping differs.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Service "traefik" is invalid: ... provided port is already allocated` | the Gateway still exists, Envoy owns NodePort 30080 | `scripts/ingress-mode.sh on` deletes it first; if you applied `deploy/ingress` by hand, `kubectl -n k8sgateway delete gateway main` and retry |
| `404 page not found` from Traefik for every URL | Ingress not picked up: wrong `ingressClassName`, or the Service name/port does not match | `kubectl -n ingress logs deploy/traefik`, `kubectl get ingress -A`, compare with `kubectl get svc -n k8sgateway` |
| Browser works, APIs answer 401 for every token and `/readyz` reports discovery errors | pods still resolve `*.127.0.0.1.nip.io` to the old (deleted) Envoy Service | `REWRITE_TARGET=traefik.ingress.svc.cluster.local scripts/coredns-rewrite.sh` |
| `scripts/up.sh` stops with "Ingress mode is active" | by design | `make ingress-off` first, or use `scripts/deploy.sh <idp>` which does not touch the data plane |
| Keycloak redirects to `http://keycloak:8080/...` | `KC_HOSTNAME` or the proxy headers missing | both are set in [deploy/idp/keycloak](../deploy/idp/keycloak); check `hostname-debug` |

## Next

Back to the [README](../README.md) for the chapter index, or to [JWT at the gateway](12-gateway-jwt.md) to see what the Gateway API adds at the edge.
