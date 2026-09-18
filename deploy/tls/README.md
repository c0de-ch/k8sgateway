# Optional TLS mode

By default everything runs over plain HTTP on `*.127.0.0.1.nip.io`, which keeps
the tutorial free of certificate handling. Real identity providers (Entra ID,
Oracle IAM) refuse plain-http redirect URIs, and browsers only treat `https://`
(or `localhost`) as a secure context, so an HTTPS variant is provided.

```bash
make tls                             # or: scripts/tls-setup.sh
SCHEME=https make switch IDP=mock    # or: SCHEME=https scripts/switch-idp.sh mock
```

`scripts/tls-setup.sh`

1. generates a local CA and a wildcard certificate for `*.127.0.0.1.nip.io`
   with `openssl` into `deploy/tls/certs/` (git-ignored),
2. creates the Secret `k8sgateway-tls` in namespace `k8sgateway`,
3. publishes the CA certificate as ConfigMap `k8sgateway-ca` (key `ca.crt`) in
   namespace `k8sgateway`,
4. applies `gateway-https.yaml`: the Gateway gets an `https` listener on 443 and
   the Envoy Service a second NodePort (30443, mapped to host port 443 by
   `deploy/kind/kind-config.yaml`) plus the in-cluster alias port 8443.

The `http` listener stays, so the plain URLs keep working. `scripts/up.sh`
notices the Secret and re-applies the https listener when it is re-run.

`SCHEME=https scripts/switch-idp.sh <idp>` then re-renders the overlay with
`https://` in every URL (issuer, `API_URL`, `PUBLIC_URL`, CORS origins,
`KC_HOSTNAME`, ...) and restarts the pods.

## How the pods trust the CA

Once the issuer is `https://idp.127.0.0.1.nip.io` (or the Keycloak realm URL),
the REST API, the GraphQL API and the Next.js BFF fetch discovery documents and
JWKS over TLS from the gateway - and a Go or Node process does not trust a CA
you generated a minute ago. The base Deployments therefore mount the ConfigMap
`k8sgateway-ca` at `/etc/k8sgateway-ca` (`optional: true`) and set

| app                    | variable                                     |
|------------------------|----------------------------------------------|
| rest-api (Go)          | `SSL_CERT_FILE=/etc/k8sgateway-ca/ca.crt`     |
| graphql-api, nextjs-app (Node) | `NODE_EXTRA_CA_CERTS=/etc/k8sgateway-ca/ca.crt` |

Both runtimes add that file *to* the system roots (real IdPs keep working), and
both are unaffected by an empty file: `scripts/deploy.sh` creates the ConfigMap
empty in plain-http mode, `tls-setup.sh` replaces it with the CA. The file is
read at process start, which is why the switch restarts the pods.

Keycloak needs nothing extra: Envoy terminates TLS and forwards
`X-Forwarded-Proto: https` (`KC_PROXY_HEADERS=xforwarded`), and the rendered
`KC_HOSTNAME=https://keycloak.127.0.0.1.nip.io` makes it advertise https URLs.
The mock IdP never calls itself and only needs its rendered `MOCK_ISSUER`.

## Trusting the CA on your machine

Browsers and command-line tools must trust `deploy/tls/certs/ca.crt`:

| where                | how                                                                                   |
|----------------------|---------------------------------------------------------------------------------------|
| curl                 | `curl --cacert deploy/tls/certs/ca.crt https://api.127.0.0.1.nip.io/api/public`       |
| Chrome / Edge        | Settings > Privacy and security > Security > Manage certificates > Authorities > Import |
| Firefox              | Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import |
| Debian/Ubuntu system | `sudo cp deploy/tls/certs/ca.crt /usr/local/share/ca-certificates/k8sgateway.crt && sudo update-ca-certificates` |
| macOS                | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain deploy/tls/certs/ca.crt` |

## Ports other than 443

On rootless Docker the cluster is created with `HTTPS_PORT=8443` (see
`scripts/up.sh --help`); the URLs then become `https://angular.127.0.0.1.nip.io:8443`
and `SCHEME=https HTTPS_PORT=8443 scripts/switch-idp.sh mock` renders them that
way. Pods reach the same listener through the alias port 8443 of the Envoy
Service that `gateway-https.yaml` adds.

## Back to plain HTTP / starting over

```bash
scripts/switch-idp.sh mock                          # http URLs again (SCHEME defaults to http)
kubectl -n k8sgateway delete secret k8sgateway-tls configmap k8sgateway-ca
kubectl apply -k deploy/gateway                     # http listener only
rm -rf deploy/tls/certs                             # optional: fresh CA next time
```
