# Mermaid equivalents of the diagrams

GitHub renders Mermaid blocks natively, so a chapter can embed either the SVG
from this folder or the Mermaid source below. Both show the same thing; the SVGs
carry more detail, the Mermaid blocks are easier to keep in sync with text edits.

Colours follow the same convention as the SVGs: blue = application code,
green = identity provider, amber = tokens.

## 1. Architecture (`architecture.svg`)

```mermaid
flowchart LR
  browser["Browser<br/>Angular SPA · Next.js pages · curl"]

  subgraph cluster["kind cluster k8sgateway"]
    direction LR
    gw["Envoy Gateway 1.9.1<br/>Gateway main (namespace k8sgateway)<br/>listener http :80 · NodePort 30080 ← host :80<br/>one HTTPRoute per hostname"]
    subgraph ns_app["namespace k8sgateway"]
      angular["angular-app (nginx :8080)<br/>angular.127.0.0.1.nip.io"]
      nextjs["nextjs-app BFF (node :3000)<br/>next.127.0.0.1.nip.io"]
      rest["rest-api (Go :8080)<br/>api.127.0.0.1.nip.io"]
      graphql["graphql-api (Node :4000)<br/>graphql.127.0.0.1.nip.io"]
    end
    subgraph ns_idp["namespace idp"]
      mock["mock-idp (fake IdP for dev)<br/>idp.127.0.0.1.nip.io"]
      kc["keycloak 26.7<br/>keycloak.127.0.0.1.nip.io"]
    end
    dns["CoreDNS rewrite<br/>*.127.0.0.1.nip.io → Envoy Service<br/>same issuer URL in browsers and pods"]
  end

  subgraph cloud["outside the cluster"]
    entra["Microsoft Entra ID<br/>login.microsoftonline.com/{TENANT_ID}/v2.0"]
    oracle["Oracle IAM Identity Domains<br/>idcs-{guid}.identity.oraclecloud.com"]
  end

  browser -->|"HTTP :80 — Host: app.127.0.0.1.nip.io"| gw
  gw --> angular & nextjs & rest & graphql
  gw --> mock & kc
  kc ~~~ dns
  browser -.->|"1 sign-in → tokens (code flow + PKCE)"| mock
  browser -.->|"2 Authorization: Bearer JWT"| rest
  rest -.->|"3 GET jwks_uri (cached)"| mock
  graphql -.->|"3 GET jwks_uri (cached)"| mock
  browser -.->|"4 sign-in when IDP=entra"| entra
  browser -.->|"4 sign-in when IDP=oracle"| oracle
  rest -.->|"JWKS"| entra
  rest -.->|"JWKS"| oracle

  classDef app fill:#eff6ff,stroke:#2563eb,color:#1f2937
  classDef idp fill:#f0fdf4,stroke:#16a34a,color:#1f2937
  classDef note fill:#f3f4f6,stroke:#6b7280,color:#1f2937
  class gw,angular,nextjs,rest,graphql app
  class mock,kc,entra,oracle idp
  class dns,browser note
```

## 2. Authorization Code Flow with PKCE (`code-flow-pkce.svg`)

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser · Angular SPA
  participant I as Identity Provider
  participant A as REST API (Go)

  B->>B: generate code_verifier, code_challenge = BASE64URL(SHA-256(code_verifier))
  B->>I: GET /authorize (response_type=code, client_id, redirect_uri, scope, state, nonce, code_challenge, S256)
  Note over B,I: scope = openid profile email — offline_access (plus an API scope) only for Entra / Oracle
  I->>I: user signs in (password, MFA, SSO cookie) — the app never sees credentials
  I-->>B: 302 redirect_uri?code=…&state=… — SPA checks state (CSRF)
  B->>I: POST /token (grant_type=authorization_code, code, code_verifier, redirect_uri, client_id)
  I-->>B: 200 access_token, id_token, refresh_token — SPA checks nonce, iss, aud in id_token
  B->>A: GET /api/orders with Authorization: Bearer access_token
  A->>I: GET /.well-known/openid-configuration → JWKS (cached, refetched on unknown kid)
  Note over A: verify signature (JWKS), iss == OIDC_ISSUER_CLAIM, aud contains OIDC_AUDIENCE,<br/>exp / nbf with 60 s skew, roles from ROLES_CLAIM, RequireRole(user)
  A-->>B: 200 JSON · 401 invalid_token · 403 forbidden
```

## 3. SPA vs. BFF (`bff-vs-spa.svg`)

```mermaid
flowchart TB
  subgraph A["A · SPA — Angular"]
    direction LR
    ab["Browser<br/>Angular SPA<br/>access · id · refresh token in JS memory"]
    aidp["IdP"]
    aa["REST / GraphQL API<br/>validates the JWT"]
    ab -->|"1 /authorize with PKCE, state, nonce"| aidp
    aidp -->|"2 tokens via POST /token (CORS)"| ab
    ab -->|"3 Authorization: Bearer access_token"| aa
    aa -.->|"4 JWKS"| aidp
  end

  subgraph B["B · BFF — Next.js"]
    direction LR
    bb["Browser<br/>Next.js pages<br/>http-only encrypted cookie, no tokens"]
    bs["Next.js server (BFF)<br/>session cookie ⇄ tokens (A256GCM)<br/>confidential client"]
    bidp["IdP"]
    ba["REST / GraphQL API<br/>same validation as A"]
    bs -->|"1 /authorize with PKCE, state, nonce"| bidp
    bidp -->|"2 tokens with client_secret"| bs
    bb -->|"3 /api/bff/* with the session cookie"| bs
    bs -->|"4 Authorization: Bearer access_token"| ba
    ba -.->|"5 JWKS"| bidp
  end
  A ~~~ B

  classDef app fill:#eff6ff,stroke:#2563eb,color:#1f2937
  classDef idp fill:#f0fdf4,stroke:#16a34a,color:#1f2937
  classDef browser fill:#ffffff,stroke:#2563eb,color:#1f2937
  class aa,ba,bs app
  class aidp,bidp idp
  class ab,bb browser
```

| | A · SPA (Angular) | B · BFF (Next.js) |
|---|---|---|
| Pros | static files (nginx, any CDN); no server state; tokens visible → easy to debug; talks to any API directly | tokens never reach the browser; confidential client with a secret; refresh and logout server-side; same-origin calls, no CORS |
| Cons | tokens readable by JavaScript (XSS); refresh token in the browser; CORS on every API; public client cannot keep a secret | needs a server and a cookie secret; cookie ≤ 4 KB; CSRF hygiene (SameSite=Lax, POST); one more hop |
| Use when | the UI is a pure static frontend and the APIs are yours | the UI already has a server (SSR) or tokens must never be exposed |

## 4. Token validation in a resource server (`token-validation.svg`)

```mermaid
flowchart TD
  req(["Request with Authorization: Bearer JWT<br/>no header or wrong scheme → 401 right away"]) --> alg
  alg["1 · alg in the allow-list?<br/>RS256 family only — never none or HS*"]
  kid["2 · kid found in the JWKS?<br/>cached · refetch once on an unknown kid"]
  jwks[("JWKS from OIDC_ISSUER discovery<br/>or OIDC_JWKS_URI")]
  sig["3 · signature valid?"]
  iss["4 · iss == OIDC_ISSUER_CLAIM?"]
  aud["5 · aud contains OIDC_AUDIENCE?"]
  exp["6 · exp / nbf valid with 60 s skew?"]
  roles["7 · roles = value at ROLES_CLAIM<br/>dotted path · array or space-separated string<br/>missing → no roles, still authenticated"]
  authz["8 · route needs a role the token carries?"]
  e401["401 invalid_token<br/>WWW-Authenticate: Bearer error=invalid_token"]
  e403["403 forbidden<br/>error=forbidden, required_role=admin"]
  ok["200 — handler runs with the verified claims"]

  alg -- yes --> kid -- yes --> sig -- yes --> iss -- yes --> aud -- yes --> exp -- yes --> roles --> authz -- yes --> ok
  jwks -.-> kid
  alg -- no --> e401
  kid -- no --> e401
  sig -- no --> e401
  iss -- no --> e401
  aud -- no --> e401
  exp -- no --> e401
  authz -- no --> e403

  classDef fail fill:#fffbeb,stroke:#d97706,color:#1f2937
  classDef ok fill:#f0fdf4,stroke:#16a34a,color:#1f2937
  classDef step fill:#ffffff,stroke:#2563eb,color:#1f2937
  classDef idp fill:#f0fdf4,stroke:#16a34a,color:#1f2937
  class e401,e403 fail
  class ok ok
  class alg,kid,sig,iss,aud,exp,roles,authz step
  class jwks idp
```

Every 401 carries `WWW-Authenticate: Bearer error="invalid_token", error_description="…"`
and the JSON body `{"error":"unauthorized","error_description":"…"}`.

## 5. Switching the IdP (`idp-switch.svg`)

```mermaid
flowchart TB
  subgraph idps["pick one identity provider"]
    direction LR
    mock["Mock IdP — development<br/>OIDC_ISSUER http://idp.127.0.0.1.nip.io<br/>ROLES_CLAIM roles<br/>OIDC_SCOPE openid profile email"]
    kc["Keycloak — in-cluster<br/>OIDC_ISSUER http://keycloak.127.0.0.1.nip.io/realms/k8sgateway<br/>ROLES_CLAIM realm_access.roles<br/>OIDC_SCOPE openid profile email (never offline_access)"]
    entra["Microsoft Entra ID — cloud<br/>OIDC_ISSUER https://login.microsoftonline.com/{TENANT_ID}/v2.0<br/>ROLES_CLAIM roles<br/>OIDC_SCOPE openid profile email offline_access api://{API_CLIENT_ID}/access_as_user"]
    oracle["Oracle IAM Identity Domains — cloud<br/>OIDC_ISSUER https://idcs-{guid}.identity.oraclecloud.com<br/>OIDC_ISSUER_CLAIM https://identity.oraclecloud.com/<br/>ROLES_CLAIM groups (verify with a decoded token)<br/>OIDC_SCOPE openid profile email offline_access + resource scope"]
  end

  sw[/"make switch IDP=keycloak<br/>scripts/render.sh → kubectl apply -f - → rollout restart"/]
  cm["ConfigMap per app — deploy/overlays/{idp}<br/>OIDC_ISSUER · OIDC_ISSUER_CLAIM · OIDC_JWKS_URI · OIDC_AUDIENCE<br/>OIDC_CLIENT_ID · OIDC_SCOPE · ROLES_CLAIM · ROLE_USER / ROLE_ADMIN"]

  mock & kc & entra & oracle --> sw --> cm
  cm -->|"config.json (subPath mount)"| angular["k8sgateway/angular-app:dev — unchanged"]
  cm -->|"env vars (envFrom)"| nextjs["k8sgateway/nextjs-app:dev — unchanged"]
  cm -->|"env vars (envFrom)"| rest["k8sgateway/rest-api:dev — unchanged"]
  cm -->|"env vars (envFrom)"| graphql["k8sgateway/graphql-api:dev — unchanged"]

  classDef idp fill:#f0fdf4,stroke:#16a34a,color:#1f2937
  classDef cfg fill:#eff6ff,stroke:#2563eb,color:#1f2937
  classDef app fill:#ffffff,stroke:#2563eb,color:#1f2937
  classDef cmd fill:#111827,stroke:#111827,color:#4ade80
  class mock,kc,entra,oracle idp
  class cm cfg
  class angular,nextjs,rest,graphql app
  class sw cmd
```
