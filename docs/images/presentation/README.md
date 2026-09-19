# Presentation video: OpenID Connect on Kubernetes

`auth-presentation.mp4` is a self-contained 5½-minute video (1400x740, H.264, 16 fps)
for presentations. It uses generic names only (Kubernetes cluster, `app.example.com`,
`api.example.com`, `idp.example.com`), so it is not tied to this repository's setup.

Structure: an intro card, then three parts that each follow the same sequence
**title card → flow diagram → animated stage → the same flow diagram again**, and a
summary card.

| Part | Title | Flow diagram | Animated stage |
|---|---|---|---|
| 1 | Setup | Administrator, identity provider, gateway, application pod, API pod: users and roles, signing key pair, client registration (`client_id`, exact `redirect_uri`, `client_secret` or PKCE), configuration by ConfigMap/Secret, routes, discovery and public keys | gateway, application pod, API pod, IdP; the checklist walks through the six setup operations |
| 2 | Login to the application | Browser, gateway, application pod, IdP: Authorization Code flow with PKCE (OAuth 2.1), the ID token and claims (OpenID Connect), userinfo, session cookie | browser, gateway, application pod, IdP - **no API pod**; seven operations from the first request to the rendered dashboard with roles |
| 3 | Using the REST and GraphQL APIs | Client, gateway, API pod, IdP: bearer token, optional gateway JWT policy, JWKS fetch, verification (signature, iss, aud, exp, roles), 200/401/403, GraphQL per-field authorization, refresh | client, gateway, API pod, IdP - **no application pod**; seven operations |

Each animated stage has an operations checklist on the left (black = pending,
highlighted = in progress, green = done), a caption bar with the current step, and
colour-coded messages: `sig` = signed with the IdP's private key, `pk` = public key,
`sec` = carries the `client_secret`, `✗` = rejected. The progress bar at the very
bottom marks the start of each part.

## Regenerate or adapt

The whole video is one HTML file, [auth-presentation.html](auth-presentation.html):
plain SVG built by JavaScript with a deterministic `render(t)`. Open it in a browser
to watch it live, or edit the timelines (captions, packets, per-party state) and
re-render from the repository root:

```bash
cd e2e && npm install && npx playwright install chromium && cd ..   # once
GIF=0 node docs/images/animation/render.mjs docs/images/presentation/auth-presentation.html docs/images/presentation/auth-presentation.gif
```

`GIF=0` skips the GIF (too long for one); the MP4 lands next to the HTML. Pause
lengths are the constants `DIAGRAM_HOLD`, `DIAGRAM_HOLD_END` and `CARD_HOLD` at the
end of the file; the stage durations are the `duration` of each `makeStage` call.
