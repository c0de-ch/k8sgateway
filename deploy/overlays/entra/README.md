# Overlay: Microsoft Entra ID

This overlay contains the exact configuration the applications need for a
Microsoft Entra ID tenant, with placeholders. `scripts/deploy.sh entra` refuses
to deploy while a `<PLACEHOLDER>` is left in any file.

## What to register in Entra ID (once)

| registration | type | settings |
|--------------|------|----------|
| `k8sgateway-api` | Web API | *Expose an API*: Application ID URI `api://<API_CLIENT_ID>`, scope `access_as_user`; *App roles*: `admin`, `user` (allowed member type Users/Groups); manifest `requestedAccessTokenVersion: 2` |
| `k8sgateway-angular` | Single-page application | redirect URI `http://angular.127.0.0.1.nip.io/callback` (platform **SPA**, not Web); API permission `k8sgateway-api / access_as_user` |
| `k8sgateway-nextjs` | Web | redirect URI `http://next.127.0.0.1.nip.io/api/auth/callback`; a client secret; API permission `k8sgateway-api / access_as_user` |

Assign users to the app roles of **k8sgateway-api** (Enterprise applications >
k8sgateway-api > Users and groups); those roles appear as `roles` in the
*access* token, which is what the APIs check.

Entra ID accepts plain `http://` redirect URIs only for `localhost`. For the
nip.io hostnames either run the TLS mode (`make tls`, then render with
`SCHEME=https`) or add a `http://localhost:4200` redirect for local Angular
development.

## Placeholders

| placeholder | value | files |
|-------------|-------|-------|
| `<TENANT_ID>` | Directory (tenant) ID | all `*.env`, `angular-config.json` |
| `<API_CLIENT_ID>` | Application (client) ID of `k8sgateway-api` (the audience of access tokens, v2 tokens use the GUID, not `api://...`) | all |
| `<ANGULAR_CLIENT_ID>` | Application (client) ID of `k8sgateway-angular` | `angular-config.json` |
| `<NEXTJS_CLIENT_ID>` | Application (client) ID of `k8sgateway-nextjs` | `nextjs.env` |
| `<NEXTJS_CLIENT_SECRET>` | its client secret | `nextjs.secret.env` |

Replace them in place (`sed -i 's/<TENANT_ID>/.../g' deploy/overlays/entra/*`)
or copy the directory to `deploy/overlays/entra.local` (git-ignored) and deploy
that: `scripts/deploy.sh entra.local`.

## Notes

- `strictDiscoveryDocumentValidation` is `false` for Angular because Entra's
  endpoints (`/oauth2/v2.0/...`, `/discovery/v2.0/keys`) do not start with the
  issuer URL. Keep `skipIssuerCheck: false` - with a tenant-specific issuer the
  check passes.
- Always request `api://<API_CLIENT_ID>/access_as_user`. With `openid profile
  email` alone Entra issues a Microsoft Graph token that your APIs cannot
  validate.
- No in-cluster IdP is deployed by this overlay; the mock IdP can rehearse
  the Entra token shape with `MOCK_FLAVOR=entra`.
