#!/usr/bin/env bash
# Switch a running installation to another identity provider.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/switch-idp.sh <idp>

  idp   mock | keycloak | entra | oracle (or a *.local copy)

Deploys the overlay (scripts/deploy.sh), then restarts the four applications so
that every pod re-reads its OIDC configuration and discovery document. The
previous in-cluster IdP keeps running (switching back is instant); remove it
with e.g.  kubectl delete -k deploy/idp/keycloak
USAGE
}
usage_if_help "${1:-}"
[[ $# -eq 1 ]] || { usage >&2; exit 2; }
idp="$1"

"$REPO_ROOT/scripts/deploy.sh" "$idp"

log "restarting the applications"
k -n k8sgateway rollout restart deployment "${WEB_APPS[@]}"
for app in "${WEB_APPS[@]}"; do
  k -n k8sgateway rollout status "deployment/$app" --timeout=300s
done
# The Deployments are ready, but Envoy learns about the new endpoints a moment later.
log "waiting until every application answers through the gateway"
for probe in "api /readyz" "graphql /readyz" "next /healthz" "angular /healthz"; do
  # shellcheck disable=SC2086
  wait_http "$(url_for $probe)" 90 || warn "$(url_for $probe) does not answer 200 yet"
done
sleep 3

# A gateway-level JWT policy is bound to one issuer; warn if it no longer matches.
policy_issuer="$(k -n k8sgateway get securitypolicy rest-api-jwt -o jsonpath='{.spec.jwt.providers[0].issuer}' 2>/dev/null || true)"
case "$idp" in mock*|keycloak*) want="$(issuer_for "${idp%%.*}")" ;; *) want="" ;; esac
if [[ -n "$policy_issuer" && "$policy_issuer" != "$want" ]]; then
  warn "SecurityPolicy rest-api-jwt still trusts issuer $policy_issuer - apply the matching file from deploy/gateway-policies/ or delete the policy"
fi

cat <<MSG

${C_GREEN}Switched to ${idp}.${C_RESET}
${C_BOLD}Reminder:${C_RESET} your browser still has a session from the previous IdP. Log out in the
application (or clear cookies for *.${BASE_DOMAIN}) before you log in again.
MSG
