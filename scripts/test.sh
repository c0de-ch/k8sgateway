#!/usr/bin/env bash
# Smoke tests against the running installation (curl only, no browser).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/test.sh [idp]

  idp   mock | keycloak (default: the IdP the deployed rest-api is configured for)

Checks discovery, the REST API (401/403/200 per user and role), the GraphQL
API, the Angular runtime config and the Next.js login redirect. Prints PASS or
FAIL per check and exits 1 if anything failed.
USAGE
}
usage_if_help "${1:-}"
need curl jq

idp="${1:-$(detect_idp)}"
case "$idp" in
  mock|keycloak) ;;
  none) die "nothing deployed yet (scripts/up.sh)" ;;
  *) die "test.sh supports the in-cluster IdPs mock and keycloak (deployed: $idp)" ;;
esac
issuer="$(issuer_for "$idp")"
api="$(url_for api)" gql="$(url_for graphql /graphql)" ng="$(url_for angular)" nx="$(url_for next)"

passed=0 failed=0
pass() { printf '%sPASS%s %s\n' "$C_GREEN" "$C_RESET" "$*"; passed=$((passed + 1)); }
fail() { printf '%sFAIL%s %s\n' "$C_RED" "$C_RESET" "$*"; failed=$((failed + 1)); }
# Retries transient failures (connection reset / 502-504 while Envoy picks up a restarted pod).
http_code() {
  local code
  for _ in 1 2 3 4; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${CURL_CA[@]}" "$@" || echo "000")"
    case "$code" in 000|502|503|504) sleep 2 ;; *) break ;; esac
  done
  echo "$code"
}
# curl_retry <curl args> -> body, retrying transient failures like http_code
curl_retry() {
  local out
  for _ in 1 2 3 4; do
    if out="$(curl -s --fail-with-body --max-time 20 "${CURL_CA[@]}" "$@")"; then printf '%s' "$out"; return 0; fi
    sleep 2
  done
  printf '%s' "$out"
}
# expect_code <description> <expected status> <curl args...>
expect_code() {
  local desc="$1" want="$2" got; shift 2
  got="$(http_code "$@")"
  if [[ "$got" == "$want" ]]; then pass "$desc -> $got"; else fail "$desc -> $got (expected $want)"; fi
}
auth() { printf 'Authorization: Bearer %s' "$1"; }

printf '%sIdP: %s (%s)%s\n' "$C_BOLD" "$idp" "$issuer" "$C_RESET"

# --- identity provider --------------------------------------------------------
expect_code "OIDC discovery document" 200 "$issuer/.well-known/openid-configuration"
tok() { "$REPO_ROOT/scripts/get-token.sh" "$1" "$idp" 2>/dev/null || true; }
t_alice="$(tok alice)"; t_bob="$(tok bob)"; t_carol="$(tok carol)"
for u in alice bob carol; do
  v="t_$u"; if [[ -n "${!v}" ]]; then pass "password grant for $u (client cli)"; else fail "password grant for $u (client cli)"; fi
done

# --- REST API -------------------------------------------------------------------
expect_code "GET /api/public without token" 200 "$api/api/public"
expect_code "GET /api/me without token" 401 "$api/api/me"
me="$(curl_retry -H "$(auth "$t_alice")" "$api/api/me" || true)"
if jq -e '.roles | index("admin")' <<<"$me" >/dev/null 2>&1; then
  pass "GET /api/me as alice -> roles include admin ($(jq -c .roles <<<"$me"))"
else
  fail "GET /api/me as alice -> roles include admin (got: $(head -c 200 <<<"$me"))"
fi
expect_code "GET /api/orders as alice (role user)" 200 -H "$(auth "$t_alice")" "$api/api/orders"
expect_code "GET /api/admin/stats as alice (role admin)" 200 -H "$(auth "$t_alice")" "$api/api/admin/stats"
expect_code "GET /api/admin/stats as bob (no admin role)" 403 -H "$(auth "$t_bob")" "$api/api/admin/stats"
expect_code "GET /api/orders as carol (no roles)" 403 -H "$(auth "$t_carol")" "$api/api/orders"
expect_code "GET /api/me with a garbage token" 401 -H "Authorization: Bearer not.a.jwt" "$api/api/me"

# --- GraphQL API ----------------------------------------------------------------
gq='{"query":"{ me { preferredUsername roles } }"}'
resp="$(curl_retry -H "$(auth "$t_alice")" -H 'Content-Type: application/json' -d "$gq" "$gql" || true)"
if jq -e '.data.me.roles | index("admin")' <<<"$resp" >/dev/null 2>&1; then
  pass "GraphQL me as alice -> $(jq -c .data.me <<<"$resp")"
else
  fail "GraphQL me as alice (got: $(head -c 200 <<<"$resp"))"
fi
resp="$(curl -s --max-time 20 "${CURL_CA[@]}" -H 'Content-Type: application/json' -d "$gq" "$gql" || true)"
[[ -n "$resp" && "$resp" != *"upstream connect error"* ]] || { sleep 3; resp="$(curl -s --max-time 20 "${CURL_CA[@]}" -H 'Content-Type: application/json' -d "$gq" "$gql" || true)"; }
if jq -e '.errors[0].extensions.code == "UNAUTHENTICATED"' <<<"$resp" >/dev/null 2>&1; then
  pass "GraphQL me without token -> UNAUTHENTICATED"
else
  fail "GraphQL me without token -> UNAUTHENTICATED (got: $(head -c 200 <<<"$resp"))"
fi

# --- Angular ----------------------------------------------------------------------
expect_code "Angular GET /" 200 "$ng/"
cfg_issuer="$(curl -s --max-time 20 "${CURL_CA[@]}" "$ng/config.json" | jq -r '.issuer // empty' 2>/dev/null || true)"
if [[ "$cfg_issuer" == "$issuer" ]]; then pass "Angular /config.json issuer = $cfg_issuer"; else fail "Angular /config.json issuer = '$cfg_issuer' (expected $issuer)"; fi

# --- Next.js -----------------------------------------------------------------------
expect_code "Next.js GET /" 200 "$nx/"
read -r code location < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' --max-time 20 "${CURL_CA[@]}" "$nx/dashboard" || echo "000 -")
if [[ "$code" =~ ^30[278]$ && "$location" == *"/api/auth/login"* ]]; then
  pass "Next.js GET /dashboard without session -> $code to $location"
else
  fail "Next.js GET /dashboard without session -> $code $location (expected 307 to /api/auth/login)"
fi

echo
printf '%s%d passed, %d failed%s\n' "$C_BOLD" "$passed" "$failed" "$C_RESET"
(( failed == 0 ))
