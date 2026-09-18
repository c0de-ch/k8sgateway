# Browser end-to-end checks

`flows.mjs` drives a headless Chromium through the real login flows of the
Angular SPA and the Next.js BFF against the IdP that is currently deployed,
verifies the role-based pages (alice sees everything, bob is denied on
`/admin`) and, with `SHOTS_DIR` set, writes the screenshots used in `docs/`.

```bash
cd e2e
npm install && npx playwright install chromium   # once
IDP=mock npm test                                 # after: make up
IDP=keycloak npm test                             # after: make switch IDP=keycloak
npm run screenshots                               # regenerate docs/images/screenshots/*.png
```

Screenshot names are shared between IdPs except `mock-idp-*` and `keycloak-*`, so
regenerate them with Keycloak deployed first and the mock IdP last (the shared
captures in the docs show the mock IdP).

The curl-only smoke tests live in `scripts/test.sh`; this is the complement
that exercises PKCE, redirects, cookies and logout in a browser.
