#!/usr/bin/env bash
# Shared helpers for the scripts in this directory. Source it, do not run it.
# shellcheck shell=bash
# shellcheck disable=SC2034  # variables are consumed by the scripts that source this file

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT
export PATH="$HOME/.local/bin:$PATH"

# Knobs (override via environment). Defaults match the manifests literally.
: "${CLUSTER_NAME:=k8sgateway}"
: "${KUBE_CONTEXT:=kind-${CLUSTER_NAME}}"
: "${BASE_DOMAIN:=127.0.0.1.nip.io}"
: "${SCHEME:=http}"
: "${HTTP_PORT:=80}"   # host port of the http listener  (rootless Docker: 8080)
: "${HTTPS_PORT:=443}" # host port of the https listener (rootless Docker: 8443)
: "${PORT_SUFFIX:=}"   # appended to every URL; derived from the port of the active scheme
: "${EG_VERSION:=v1.9.1}"
: "${IDP:=mock}"
if [[ -z "$PORT_SUFFIX" ]]; then
  if [[ "$SCHEME" == https && "$HTTPS_PORT" != 443 ]]; then PORT_SUFFIX=":$HTTPS_PORT"
  elif [[ "$SCHEME" == http && "$HTTP_PORT" != 80 ]]; then PORT_SUFFIX=":$HTTP_PORT"; fi
fi
export CLUSTER_NAME KUBE_CONTEXT BASE_DOMAIN SCHEME HTTP_PORT HTTPS_PORT PORT_SUFFIX EG_VERSION IDP

# curl options for URLs behind the gateway: trust the local CA from scripts/tls-setup.sh when it exists,
# so https:// URLs work from the host as well (usage: curl "${CURL_CA[@]}" ...).
CURL_CA=()
[[ -f "$REPO_ROOT/deploy/tls/certs/ca.crt" ]] && CURL_CA=(--cacert "$REPO_ROOT/deploy/tls/certs/ca.crt")

APPS=(mock-idp angular-app nextjs-app rest-api graphql-api)
WEB_APPS=(angular-app nextjs-app rest-api graphql-api) # deployed in namespace k8sgateway

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_BLUE=$'\e[34m' C_BOLD=$'\e[1m' C_RESET=$'\e[0m'
else
  C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_BOLD='' C_RESET=''
fi
log()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s ok %s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
need() { local t; for t in "$@"; do command -v "$t" >/dev/null 2>&1 || die "required tool not found: $t"; done; }

# kubectl pinned to the kind context so a stray KUBECONFIG never hits another cluster.
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

# url_for <host label> [path] -> http://<label>.127.0.0.1.nip.io[path]
url_for() { printf '%s://%s.%s%s%s' "$SCHEME" "$1" "$BASE_DOMAIN" "$PORT_SUFFIX" "${2:-}"; }

# issuer_for <mock|keycloak> -> issuer URL of an in-cluster IdP
issuer_for() {
  case "$1" in
    mock) url_for idp ;;
    keycloak) url_for keycloak /realms/k8sgateway ;;
    *) die "no in-cluster issuer for IdP '$1' (use mock or keycloak)" ;;
  esac
}

# detect_idp -> which IdP the deployed rest-api is configured for (mock|keycloak|external|none)
detect_idp() {
  local cm iss
  cm="$(k -n k8sgateway get deploy rest-api -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].configMapRef.name}' 2>/dev/null || true)"
  [[ -n "$cm" ]] || { echo none; return; }
  iss="$(k -n k8sgateway get cm "$cm" -o jsonpath='{.data.OIDC_ISSUER}' 2>/dev/null || true)"
  case "$iss" in
    *keycloak.*) echo keycloak ;;
    *idp.*) echo mock ;;
    "") echo none ;;
    *) echo external ;;
  esac
}

# ensure_ca_configmap: the server-side apps mount ConfigMap k8sgateway-ca and
# point SSL_CERT_FILE / NODE_EXTRA_CA_CERTS at ca.crt in it (optional TLS mode,
# scripts/tls-setup.sh fills it). Create it empty so plain-http installations
# never see a "missing CA file" warning.
ensure_ca_configmap() {
  k -n k8sgateway get configmap k8sgateway-ca >/dev/null 2>&1 && return 0
  k -n k8sgateway create configmap k8sgateway-ca --from-literal=ca.crt= --dry-run=client -o yaml | k apply -f - >/dev/null
  ok "ConfigMap k8sgateway/k8sgateway-ca created (empty; scripts/tls-setup.sh fills it)"
}

# ensure_mock_signing_key: persistent RS256 key for the mock IdP (Secret
# idp/mock-idp-key, mounted at /keys/key.pem). Generated once with openssl so
# the JWKS "kid" survives pod restarts and cached JWKS stay valid.
ensure_mock_signing_key() {
  k -n idp get secret mock-idp-key >/dev/null 2>&1 && return 0
  need openssl
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null \
    | k -n idp create secret generic mock-idp-key --from-file=key.pem=/dev/stdin >/dev/null
  ok "Secret idp/mock-idp-key created (signing key of the mock IdP, demo value)"
}

# decode_jwt_payload <jwt> -> JSON payload on stdout (no verification!)
decode_jwt_payload() {
  local p
  p="$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')"
  while (( ${#p} % 4 )); do p+='='; done
  printf '%s' "$p" | base64 -d 2>/dev/null
}

# wait_http <url> <timeout-seconds> -> succeeds once the URL answers 200
wait_http() {
  local url="$1" timeout="${2:-120}" start now
  start=$(date +%s)
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${CURL_CA[@]}" "$url" || true)" == "200" ]]; do
    now=$(date +%s)
    (( now - start < timeout )) || return 1
    sleep 2
  done
}

# Every script implements usage(); this prints it for -h/--help.
usage_if_help() { if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi; }
