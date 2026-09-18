# Overlay: Oracle IAM Identity Domains

Configuration for an OCI IAM identity domain (formerly IDCS), with
placeholders. `scripts/deploy.sh oracle` refuses to deploy while a
`<PLACEHOLDER>` is left in any file.

## What to create in the identity domain (once)

| application | type | settings |
|-------------|------|----------|
| `k8sgateway-api` | Confidential application, **Resource server** configuration only | Primary audience `https://api.k8sgateway.local/` (keep the trailing slash - the fully qualified scope is audience + scope), scope `orders.read`, "Allow token refresh" |
| `k8sgateway-angular` | Mobile application (= public client, no secret) | grant types Authorization code + Refresh token, PKCE, redirect URL `http://angular.127.0.0.1.nip.io/callback`, post-logout `http://angular.127.0.0.1.nip.io/`, tick "Allow non-HTTPS URLs"; Token issuance policy: add resource `k8sgateway-api`, scope `orders.read`, "Bypass consent" |
| `k8sgateway-nextjs` | Confidential application | grant types Authorization code + Refresh token, redirect URL `http://next.127.0.0.1.nip.io/api/auth/callback`, "Allow HTTP URLs"; same resource + scope |

Domain settings: enable **Access signing certificate** ("Configure client
access"), otherwise the JWKS endpoint `/admin/v1/SigningCert/jwk` answers 401
for the APIs.

## Placeholders

| placeholder | value | files |
|-------------|-------|-------|
| `<DOMAIN_URL>` | Domain URL host, e.g. `idcs-1234abcd.identity.oraclecloud.com` (no scheme, no `:443`) | all `*.env`, `angular-config.json` |
| `<ANGULAR_CLIENT_ID>` | client ID of `k8sgateway-angular` | `angular-config.json` |
| `<NEXTJS_CLIENT_ID>` | client ID of `k8sgateway-nextjs` | `nextjs.env` |
| `<NEXTJS_CLIENT_SECRET>` | its client secret | `nextjs.secret.env` |

## Things to verify against a decoded token from YOUR domain

Oracle's documentation is not consistent about two details, so the overlay
makes both explicit and you should confirm them with a real access token
(`scripts/get-token.sh --decode` works for the mock IdP; for Oracle paste the
token into the mock IdP's `/debug/token` page or `jwt.io`):

- `OIDC_ISSUER_CLAIM=https://identity.oraclecloud.com/` - the `iss` claim.
  The discovery document is fetched from `https://<DOMAIN_URL>` but its
  `issuer` field (and the tokens' `iss`) is the fixed Oracle value. If your
  tokens show `https://<DOMAIN_URL>/` instead, change `OIDC_ISSUER_CLAIM`.
- `ROLES_CLAIM=groups` - Oracle does not put groups or app roles into the
  access token by default (`scope=groups` only lets the token *fetch* them from
  `/oauth2/v1/userinfo`). Add a custom claim on the domain (Admin API
  `/admin/v1/CustomClaims`, token type `AT`) named e.g. `groups` that expands
  the user's group names, then set `ROLES_CLAIM` to that claim name.

Other Oracle specifics already reflected in the files: token endpoint auth
`client_secret_basic` (`OIDC_CLIENT_AUTH`), Angular `skipIssuerCheck: true`
and `strictDiscoveryDocumentValidation: false` (issuer differs from the
discovery URL), scope `https://api.k8sgateway.local/orders.read`.

No in-cluster IdP is deployed by this overlay; the mock IdP can rehearse the
Oracle token shape with `MOCK_FLAVOR=oracle` and `MOCK_ISSUER_CLAIM`.
