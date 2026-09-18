#!/usr/bin/env bash
# Optional TLS mode: local CA + wildcard certificate, Secret, https listener,
# and the CA published to the pods so they can talk to an https:// issuer.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/tls-setup.sh

1. creates (once) a local CA and a wildcard certificate for *.$BASE_DOMAIN in
   deploy/tls/certs/ (git-ignored),
2. stores the certificate as Secret k8sgateway-tls in namespace k8sgateway,
3. publishes the CA as ConfigMap k8sgateway-ca - the REST, GraphQL and Next.js
   pods mount it (SSL_CERT_FILE / NODE_EXTRA_CA_CERTS), so they can fetch
   discovery and JWKS from an https:// issuer,
4. applies deploy/tls/gateway-https.yaml: https:443 listener on the Gateway and
   NodePort 30443 (+ in-cluster alias 8443) on the Envoy Service.

Afterwards switch the applications to https URLs (re-renders the overlay and
restarts the pods, which read the CA at start):
  SCHEME=https scripts/switch-idp.sh mock      # or keycloak
and trust deploy/tls/certs/ca.crt in your browser (see deploy/tls/README.md).
USAGE
}
usage_if_help "${1:-}"
need openssl kubectl
certs="$REPO_ROOT/deploy/tls/certs"
mkdir -p "$certs"

if [[ ! -f "$certs/ca.key" ]]; then
  log "creating local CA"
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -keyout "$certs/ca.key" -out "$certs/ca.crt" \
    -subj "/CN=k8sgateway local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
fi

if [[ ! -f "$certs/tls.crt" ]] || ! openssl x509 -in "$certs/tls.crt" -noout -checkend 86400 >/dev/null 2>&1; then
  log "issuing wildcard certificate for *.$BASE_DOMAIN"
  openssl req -newkey rsa:2048 -nodes -keyout "$certs/tls.key" -out "$certs/tls.csr" -subj "/CN=*.$BASE_DOMAIN" >/dev/null 2>&1
  printf 'subjectAltName=DNS:*.%s,DNS:%s\nextendedKeyUsage=serverAuth\n' "$BASE_DOMAIN" "$BASE_DOMAIN" > "$certs/san.ext"
  openssl x509 -req -sha256 -days 825 -in "$certs/tls.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" \
    -CAcreateserial -extfile "$certs/san.ext" -out "$certs/tls.crt" >/dev/null 2>&1
  rm -f "$certs/tls.csr" "$certs/san.ext"
fi
ok "certificate: $(openssl x509 -in "$certs/tls.crt" -noout -subject -enddate | tr '\n' ' ')"

k apply -f "$REPO_ROOT/deploy/base/namespaces.yaml" >/dev/null
log "creating Secret k8sgateway/k8sgateway-tls"
k -n k8sgateway create secret tls k8sgateway-tls --cert="$certs/tls.crt" --key="$certs/tls.key" \
  --dry-run=client -o yaml | k apply -f - >/dev/null

log "publishing the CA to the pods (ConfigMap k8sgateway/k8sgateway-ca)"
k -n k8sgateway create configmap k8sgateway-ca --from-file=ca.crt="$certs/ca.crt" \
  --dry-run=client -o yaml | k apply -f - >/dev/null

log "adding the https listener and NodePort 30443"
sed "s/\*\.127\.0\.0\.1\.nip\.io/*.${BASE_DOMAIN}/" "$REPO_ROOT/deploy/tls/gateway-https.yaml" | k apply -f -
k -n k8sgateway wait gateway/main --for=condition=Programmed --timeout=300s >/dev/null

https_suffix=""; [[ "$HTTPS_PORT" == 443 ]] || https_suffix=":$HTTPS_PORT"
# Programmed=True comes a few seconds before Envoy actually serves the new listener.
log "waiting for the https listener to answer"
for _ in $(seq 1 30); do
  curl -s -o /dev/null --max-time 3 --cacert "$certs/ca.crt" "https://api.${BASE_DOMAIN}${https_suffix}/" && break
  sleep 2
done
cur="$(detect_idp 2>/dev/null || true)"; case "$cur" in mock|keycloak) IDP="$cur" ;; esac
cat <<MSG

${C_GREEN}TLS listener ready:${C_RESET} https://api.${BASE_DOMAIN}${https_suffix}/api/public
Trust the CA (${certs}/ca.crt) in your browser / OS - instructions in deploy/tls/README.md.
Test now:  curl --cacert ${certs}/ca.crt https://api.${BASE_DOMAIN}${https_suffix}/api/public
Switch the applications (issuer, redirect URIs, CORS origins) to https and restart
them so they load the CA:   SCHEME=https scripts/switch-idp.sh ${IDP}
MSG
