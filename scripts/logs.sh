#!/usr/bin/env bash
# Tail the logs of one component.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/logs.sh [component]

  component   rest-api (default) | graphql-api | angular-app | nextjs-app
              mock-idp | keycloak | envoy (proxy access log) | envoy-gateway (controller)
environment
  TAIL=100    number of lines to start with
USAGE
}
usage_if_help "${1:-}"
comp="${1:-rest-api}"
tail_n="${TAIL:-100}"
case "$comp" in
  angular-app|nextjs-app|rest-api|graphql-api) exec kubectl --context "$KUBE_CONTEXT" -n k8sgateway logs -f --tail="$tail_n" "deployment/$comp" ;;
  mock-idp|keycloak) exec kubectl --context "$KUBE_CONTEXT" -n idp logs -f --tail="$tail_n" "deployment/$comp" ;;
  envoy) exec kubectl --context "$KUBE_CONTEXT" -n envoy-gateway-system logs -f --tail="$tail_n" -c envoy \
           -l gateway.envoyproxy.io/owning-gateway-name=main,gateway.envoyproxy.io/owning-gateway-namespace=k8sgateway ;;
  envoy-gateway) exec kubectl --context "$KUBE_CONTEXT" -n envoy-gateway-system logs -f --tail="$tail_n" deployment/envoy-gateway ;;
  *) die "unknown component '$comp' (see --help)" ;;
esac
