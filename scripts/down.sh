#!/usr/bin/env bash
# Delete the kind cluster (and with it everything the tutorial deployed).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { echo "usage: scripts/down.sh   - deletes the kind cluster '$CLUSTER_NAME' (images stay in the local docker cache)"; }
usage_if_help "${1:-}"
need kind
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  log "deleting kind cluster $CLUSTER_NAME"
  kind delete cluster --name "$CLUSTER_NAME"
  ok "deleted"
else
  ok "kind cluster $CLUSTER_NAME does not exist"
fi
