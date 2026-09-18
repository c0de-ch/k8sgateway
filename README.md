# k8sgateway

[![ci](https://github.com/c0de-ch/k8sgateway/actions/workflows/ci.yml/badge.svg)](https://github.com/c0de-ch/k8sgateway/actions/workflows/ci.yml)

A hands-on tutorial for **JWT-protected web applications on Kubernetes**. An external OpenID Connect identity provider (IdP) authenticates users and manages accounts and roles; the applications never see a password. The two frontends only *obtain* tokens, the two APIs only *validate* them. Everything runs on a local [kind](https://kind.sigs.k8s.io/) cluster behind the Kubernetes Gateway API ([Envoy Gateway](https://gateway.envoyproxy.io/)). You start with a built-in mock IdP and switch to Keycloak, Microsoft Entra ID or Oracle IAM Identity Domains with one command: the container images stay the same, only a ConfigMap changes.

![Architecture: browser, Envoy Gateway, the four applications, the in-cluster IdPs and the cloud IdPs](docs/images/architecture.svg)

*The kind cluster: the browser reaches Envoy on port 80, one HTTPRoute per hostname routes to the apps in `k8sgateway` and to the IdPs in `idp`; a CoreDNS rewrite lets pods use the same `*.127.0.0.1.nip.io` URLs as the browser.*

## What is inside

| Component | Stack | What it demonstrates | Path |
|---|---|---|---|
| Angular SPA | Angular 22, angular-oauth2-oidc, nginx | Public client: Authorization Code flow + PKCE in the browser, tokens held by the SPA, bearer calls to both APIs, runtime `config.json` | [apps/angular-app](apps/angular-app) |
| Next.js BFF | Next.js 16 (App Router), openid-client 6, jose | Confidential client, backend-for-frontend: tokens in an encrypted HttpOnly cookie, server-side relay, real HTTP 403 pages | [apps/nextjs-app](apps/nextjs-app) |
| REST API | Go 1.27, chi, go-oidc | Resource server: JWKS signature check, `iss`/`aud`/`exp` rules, role middleware, RFC 6750 `401`/`403` shapes | [apps/rest-api](apps/rest-api) |
| GraphQL API | Node 22, Apollo Server 5, jose | The same validation in TypeScript, field-level authorization, token relay to the REST API | [apps/graphql-api](apps/graphql-api) |
| Mock IdP | Node 22, Express 5, jose | A small, readable OIDC provider that imitates the token shapes of Keycloak, Entra ID and Oracle IAM Identity Domains | [apps/mock-idp](apps/mock-idp) |
| Keycloak | Keycloak 26.7 (`start-dev --import-realm`) | A real IdP in the cluster: realm `k8sgateway` with users, roles, clients and an audience mapper | [deploy/idp/keycloak](deploy/idp/keycloak) |
| Gateway | Envoy Gateway 1.9.1, Gateway API | One `Gateway`, one `HTTPRoute` per hostname, optional JWT `SecurityPolicy` at the edge | [deploy/gateway](deploy/gateway), [deploy/gateway-policies](deploy/gateway-policies) |
| Overlays | kustomize | One base, one overlay per IdP; placeholder guard for the cloud IdPs; optional TLS mode | [deploy/overlays](deploy/overlays), [deploy/tls](deploy/tls) |
| Ingress variant | Traefik v3 (Ingress controller) | The same six hostnames routed by classic `Ingress` resources instead of the Gateway API; switch with one command | [deploy/ingress](deploy/ingress) |
| Scripts | bash | `up`, `down`, `build`, `deploy`, `switch-idp`, `get-token`, `test`, `render` | [scripts](scripts), [Makefile](Makefile) |
| Browser tests | Playwright | The real login flows of both frontends, and the screenshots used in the docs | [e2e](e2e) |

## Quickstart (5 minutes)

Prerequisites: Docker, kind v0.33+, kubectl, `curl`, `jq` and `openssl` (used to generate the mock IdP's signing key), and free ports 80 and 443 on `127.0.0.1`. Nothing else: every image is built inside Docker (multi-stage), so no Go or Node toolchain is needed on the host.

```bash
git clone https://github.com/c0de-ch/k8sgateway.git
cd k8sgateway
make up            # kind cluster + Envoy Gateway + images + mock IdP + the four apps (first run: a few minutes)
```

When it finishes, open the applications:

| | URL |
|---|---|
| Angular SPA | <http://angular.127.0.0.1.nip.io> |
| Next.js BFF | <http://next.127.0.0.1.nip.io> |
| REST API | <http://api.127.0.0.1.nip.io/api/public> |
| GraphQL API | <http://graphql.127.0.0.1.nip.io/graphql> |
| Mock IdP dashboard | <http://idp.127.0.0.1.nip.io> |

Log in as `alice` (password `alice`), then run the checks and switch the IdP:

```bash
make test                  # curl smoke tests: discovery, 200/401/403 matrix, GraphQL, Angular config, Next.js redirect
make switch IDP=keycloak   # deploy Keycloak, re-point the apps, restart them (Keycloak starts in about 15 s; the first run also pulls its image, which takes longer)
make test                  # same checks, now against Keycloak
make down                  # delete the cluster
```

If Docker runs rootless (or ports 80/443 are taken), create the cluster with `HTTP_PORT=8080 HTTPS_PORT=8443 make up`; every URL then carries the port (`http://angular.127.0.0.1.nip.io:8080`). Details in [docs/14-troubleshooting.md](docs/14-troubleshooting.md).

## Demo users

The same users exist in the mock IdP and in the Keycloak realm; the password equals the username.

| Username | Password | Name | Email | Roles |
|---|---|---|---|---|
| `alice` | `alice` | Alice Admin | alice@example.com | `admin`, `user` |
| `bob` | `bob` | Bob User | bob@example.com | `user` |
| `carol` | `carol` | Carol Guest | carol@example.com | none (authenticated, but every role-protected route answers 403) |

## Identity providers

| IdP | Where it runs | Issuer (`OIDC_ISSUER`) | Roles claim | Redirect URIs | Chapter |
|---|---|---|---|---|---|
| Mock IdP | in the cluster, namespace `idp` | `http://idp.127.0.0.1.nip.io` | `roles` | any URI accepted by default (`MOCK_ALLOW_ANY_REDIRECT=true`); plain http | [04](docs/04-mock-idp.md) |
| Keycloak 26 | in the cluster, namespace `idp` | `http://keycloak.127.0.0.1.nip.io/realms/k8sgateway` | `realm_access.roles` | registered per client in the realm export (exact URI for the BFF, wildcard for the SPA); plain http allowed in dev mode | [05](docs/05-keycloak.md) |
| Microsoft Entra ID | your tenant (cloud) | `https://login.microsoftonline.com/<TENANT_ID>/v2.0` | `roles` (app roles defined on the API registration) | https only; plain http is accepted for `localhost` alone, so use the TLS mode (`make tls`) or run the frontends locally on `http://localhost` ([chapter 6](docs/06-entra-id.md)) | [06](docs/06-entra-id.md) |
| Oracle IAM Identity Domains | your OCI identity domain (cloud) | discovery at `https://<DOMAIN_URL>` (the domain URL host, e.g. `idcs-1234abcd.identity.oraclecloud.com`), `iss` claim `https://identity.oraclecloud.com/` (verify with a decoded token from your tenant) | `groups` via a custom claim (verify with a decoded token from your tenant) | https by default; http only with "Allow non-HTTPS URLs" on the application | [07](docs/07-oracle-iam.md) |

All four are driven by the same set of environment variables (`OIDC_ISSUER`, `OIDC_AUDIENCE`, `ROLES_CLAIM`, ...); [docs/13-switching-idps.md](docs/13-switching-idps.md) lists them side by side.

## Tutorial

1. [Concepts](docs/01-concepts.md): OAuth 2.0, OIDC, JWTs, access vs. ID vs. refresh tokens, code flow + PKCE, SPA vs. BFF, the validation rules.
2. [Architecture](docs/02-architecture.md): the cluster, the gateway, hostnames, namespaces and the CoreDNS trick.
3. [Quickstart](docs/03-quickstart.md): what `make up` does step by step, a guided tour, the automated checks.
4. [Mock IdP](docs/04-mock-idp.md): the development IdP, its endpoints, flavors and token debugger.
5. [Keycloak](docs/05-keycloak.md): the realm export, clients, roles, the audience mapper and Keycloak's refresh-token rules.
6. [Microsoft Entra ID](docs/06-entra-id.md): app registrations, app roles, v2 tokens, `access_as_user`, TLS mode.
7. [Oracle IAM Identity Domains](docs/07-oracle-iam.md): resource server, issuer mismatch, JWKS endpoint, custom claims.
8. [Angular SPA](docs/08-angular.md): PKCE in the browser, runtime configuration, interceptor, role gating, logout.
9. [Next.js BFF](docs/09-nextjs.md): encrypted session cookie, `proxy.ts`, relay handlers, refresh, 403 pages.
10. [REST API in Go](docs/10-rest-api-go.md): go-oidc verifier, role middleware, error shapes, readiness coupled to the IdP.
11. [GraphQL API](docs/11-graphql-api.md): jose verification, resolver-level authorization, token relay, HTTP status policy.
12. [JWT at the gateway](docs/12-gateway-jwt.md): Envoy Gateway `SecurityPolicy` as defense in depth.
13. [Switching IdPs](docs/13-switching-idps.md): overlays, the variable matrix, what a switch really changes.
14. [Troubleshooting](docs/14-troubleshooting.md): ports, DNS, secure contexts, issuer mismatches, stale JWKS.
15. [Production checklist](docs/15-production-checklist.md): what to change before this leaves your laptop.
16. [Ingress instead of the Gateway API](docs/16-ingress.md): the same setup with a classic Ingress controller (Traefik), the full walk-through and where JWT validation happens without a gateway policy.

## Repository layout

```text
.
├── apps/
│   ├── angular-app/        Angular 22 SPA (public client, PKCE)
│   ├── nextjs-app/         Next.js 16 BFF (confidential client, cookie session)
│   ├── rest-api/           Go REST API (resource server)
│   ├── graphql-api/        Node/TypeScript GraphQL API (resource server + token relay)
│   └── mock-idp/           development OIDC provider
├── deploy/
│   ├── kind/               kind cluster config (host 80/443 -> NodePorts 30080/30443)
│   ├── gateway/            GatewayClass, EnvoyProxy, Gateway
│   ├── base/               Deployments, Services, HTTPRoutes of the four apps
│   ├── idp/                mock IdP and Keycloak manifests
│   ├── overlays/           mock | keycloak | entra | oracle (per-IdP ConfigMaps)
│   ├── gateway-policies/   optional SecurityPolicy examples (JWT at the edge)
│   ├── tls/                optional https listener with a local CA
│   └── ingress/            alternative: Traefik Ingress controller + one Ingress per hostname
├── scripts/                up.sh, down.sh, build.sh, deploy.sh, switch-idp.sh, get-token.sh, test.sh, render.sh, ...
├── e2e/                    Playwright browser checks and screenshot generator
├── docs/                   the tutorial chapters, diagrams and screenshots
├── .github/workflows/      CI: image builds, unit tests, kind e2e (mock -> Keycloak)
└── Makefile                make up | down | build | deploy | switch | test | token | urls | logs | tls | ingress-on | ingress-off | lint
```

## How the pieces talk

The browser opens `http://<name>.127.0.0.1.nip.io`; nip.io resolves that to `127.0.0.1`, kind forwards host port 80 to NodePort 30080, and the Envoy proxy behind the `Gateway` routes on the `Host` header to the matching `HTTPRoute`. A frontend that needs a login redirects the browser to the IdP's authorization endpoint and later exchanges the code for tokens; every call to an API carries `Authorization: Bearer <access token>`. The APIs download the IdP's public keys once (`jwks_uri` from discovery) and validate every token locally: signature, issuer, audience, expiry, then roles. Because pods resolve `*.127.0.0.1.nip.io` to the Envoy Service (a CoreDNS rewrite), the issuer URL in the browser, in the token's `iss` claim and in the pods' configuration is one and the same string, which is exactly what OIDC validation requires.

## License

MIT, see [LICENSE](LICENSE).
