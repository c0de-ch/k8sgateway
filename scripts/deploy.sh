#!/usr/bin/env bash
# Deploy (or re-deploy) the applications configured for one identity provider.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/deploy.sh <idp>

  idp   mock | keycloak | entra | oracle (or a *.local copy of the last two)

Renders deploy/overlays/<idp> (scripts/render.sh), applies it, waits for the
in-cluster IdP (mock-idp or keycloak) and the four applications to roll out
and, for in-cluster IdPs, for the OIDC discovery document to answer.

Pods that already run keep their old configuration until they are restarted:
use scripts/switch-idp.sh to change the IdP of a running installation.
USAGE
}
usage_if_help "${1:-}"
[[ $# -eq 1 ]] || { usage >&2; exit 2; }
need kubectl curl
idp="$1"

# Namespaces first: the Secret and ConfigMap below live in them and the
# rendered overlay only references (never contains) the two.
k apply -f "$REPO_ROOT/deploy/base/namespaces.yaml" >/dev/null
ensure_ca_configmap
case "$idp" in mock*) ensure_mock_signing_key ;; esac

log "rendering overlay $idp and applying it to context $KUBE_CONTEXT"
"$REPO_ROOT/scripts/render.sh" "$idp" | k apply -f -

case "$idp" in
  mock*)
    log "waiting for mock-idp"
    k -n idp rollout status deployment/mock-idp --timeout=180s
    ;;
  keycloak*)
    log "waiting for keycloak (first start takes 1-2 minutes)"
    k -n idp rollout status deployment/keycloak --timeout=600s
    ;;
esac

log "waiting for the applications in namespace k8sgateway"
for app in "${WEB_APPS[@]}"; do
  k -n k8sgateway rollout status "deployment/$app" --timeout=300s \
    || die "deployment $app did not become ready. Images missing? run scripts/build.sh; details: kubectl -n k8sgateway describe pod -l app.kubernetes.io/name=$app"
done

case "$idp" in
  mock*|keycloak*)
    disc="$(issuer_for "${idp%%.*}")/.well-known/openid-configuration"
    log "waiting for OIDC discovery at $disc"
    wait_http "$disc" 180 || die "discovery document not reachable from this machine: $disc"
    ok "issuer $(curl -fsS "${CURL_CA[@]}" "$disc" | jq -r .issuer)"
    ;;
  *)
    ok "external IdP overlay applied (nothing to wait for in namespace idp)"
    ;;
esac
ok "overlay $idp deployed"
