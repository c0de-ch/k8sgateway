#!/usr/bin/env bash
# Obtain an access token from the mock IdP or Keycloak for scripts and curl.
# Uses the resource-owner password grant on the public client "cli" - a grant
# type that exists here ONLY for tests; real applications use the code flow.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/get-token.sh [options] [user] [idp]

  user   alice | bob | carol (default alice; password = user name, override with PASSWORD)
  idp    mock | keycloak     (default: whatever is deployed, else \$IDP)

options
  -d, --decode              print the decoded header and payload instead of the raw token
  -c, --client-credentials  machine-to-machine token for client svc-batch (no user)
  -h, --help

examples
  TOKEN=\$(scripts/get-token.sh alice)
  curl -H "Authorization: Bearer \$TOKEN" http://api.127.0.0.1.nip.io/api/me
  scripts/get-token.sh --decode bob keycloak
USAGE
}

decode=0 client_creds=0 args=()
for a in "$@"; do
  case "$a" in
    -h|--help) usage; exit 0 ;;
    -d|--decode) decode=1 ;;
    -c|--client-credentials) client_creds=1 ;;
    -*) die "unknown option $a" ;;
    *) args+=("$a") ;;
  esac
done
need curl jq
user="${args[0]:-alice}"
idp="${args[1]:-}"
if [[ -z "$idp" ]]; then
  idp="$(detect_idp 2>/dev/null || true)"
  [[ "$idp" == mock || "$idp" == keycloak ]] || idp="$IDP"
fi
issuer="$(issuer_for "$idp")"

token_endpoint="$(curl -fsS --max-time 10 "${CURL_CA[@]}" "$issuer/.well-known/openid-configuration" | jq -r .token_endpoint)" \
  || die "cannot read discovery document at $issuer (is the IdP deployed? scripts/deploy.sh $idp)"

if (( client_creds )); then
  response="$(curl -sS --max-time 10 "${CURL_CA[@]}" -X POST "$token_endpoint" \
    -d grant_type=client_credentials \
    -d "client_id=${SVC_CLIENT_ID:-svc-batch}" \
    -d "client_secret=${SVC_CLIENT_SECRET:-svc-batch-secret}")"
else
  response="$(curl -sS --max-time 10 "${CURL_CA[@]}" -X POST "$token_endpoint" \
    -d grant_type=password -d client_id=cli \
    -d "username=$user" -d "password=${PASSWORD:-$user}" \
    -d "scope=openid profile email")"
fi
token="$(jq -r '.access_token // empty' <<<"$response")"
[[ -n "$token" ]] || die "token request failed: $(jq -c . <<<"$response" 2>/dev/null || echo "$response")"

if (( decode )); then
  echo "header:";  decode_jwt_payload "x.$(cut -d. -f1 <<<"$token")" | jq .
  echo "payload:"; decode_jwt_payload "$token" | jq .
else
  printf '%s\n' "$token"
fi
