# Diagrams

Hand-written SVG diagrams used by the tutorial chapters. They embed no external
fonts or images (system font stack, light canvas so they stay readable in GitHub
dark mode) and share one palette: slate text `#1f2937`, blue `#2563eb` for
application code, green `#16a34a` for identity providers, amber `#d97706` for
tokens, gray `#6b7280` for notes.

| Image | Caption |
|---|---|
| [`architecture.svg`](architecture.svg) | The kind cluster: browser → Envoy Gateway (port 80 via NodePort 30080) → HTTPRoutes → the four apps in `k8sgateway`, mock IdP and Keycloak in `idp`, cloud IdPs outside, CoreDNS rewrite so pods reach `*.127.0.0.1.nip.io` through the gateway. |
| [`code-flow-pkce.svg`](code-flow-pkce.svg) | Sequence diagram of the Authorization Code Flow with PKCE: verifier/challenge, `/authorize`, login at the IdP, code + state, `/token`, tokens, Bearer call, JWKS-based validation, 200/401/403. |
| [`bff-vs-spa.svg`](bff-vs-spa.svg) | SPA (Angular, tokens in the browser, direct API calls) next to BFF (Next.js, tokens in an encrypted HttpOnly cookie session, `/api/bff/*` relay), with pros and cons. |
| [`token-validation.svg`](token-validation.svg) | What a resource server checks: alg allow-list → kid → cached JWKS → signature → `iss` → `aud` → `exp`/`nbf` with skew → roles from `ROLES_CLAIM` → authorize → 401 / 403 / 200. |
| [`idp-switch.svg`](idp-switch.svg) | Same images, different ConfigMap: the four IdP cards (mock, Keycloak, Entra ID, Oracle IAM Identity Domains) with issuer pattern, roles claim and scope, `make switch IDP=…`, and the unchanged app images. |

Screenshots (PNG) are not hand-written: the Playwright browser tests under
`e2e/` generate them from the running mock IdP setup — see that folder's
README for the output location.

## Embedding

```markdown
![Architecture](architecture.svg)
```

Each diagram also exists as a Mermaid block in [`mermaid.md`](mermaid.md), which
GitHub renders inline; copy the block into a chapter when text and picture must
stay editable together.

## Animation

| file | caption |
|---|---|
| [`auth-flow.gif`](auth-flow.gif) | Authorization Code flow with PKCE followed by the API's JWT verification: what travels between browser, IdP and API, which key signs and which key verifies, and a tampered token being rejected. 960x540, 58 s, loops. |
| [`login-flow-k8s.gif`](login-flow-k8s.gif) | The login seen from the cluster for the Next.js BFF: setup (IdP key pair, client registration, discovery, public keys), login through Envoy Gateway with OAuth 2.1 + OIDC, claims and roles/groups from the ID token and `/userinfo`, the bearer call to the API with gateway pre-check, refresh-token rotation, with an operations checklist (pending / in progress / done) on the left. 1400x740, 2 min, loops. |
| [`animation/login-flow-k8s.html`](animation/login-flow-k8s.html) | Its scene; open in a browser to watch it live. |
| [`animation/auth-flow.html`](animation/auth-flow.html) | The scene (plain SVG + JavaScript, deterministic `render(t)`); open it in a browser to watch it live. |
| [`animation/render.mjs`](animation/render.mjs) | Captures the frames with Playwright's Chromium (from `e2e/node_modules`) and assembles the GIF with ffmpeg: `node docs/images/animation/render.mjs [scene.html] [out.gif]`. |
