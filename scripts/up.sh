#!/usr/bin/env bash
# From zero to a running demo: kind cluster, Envoy Gateway, the DNS trick,
# application images, the selected identity provider and the applications.
# Safe to re-run: every step is idempotent.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/up.sh

environment
  IDP=mock|keycloak   identity provider to deploy (default mock)
  SKIP_BUILD=1        do not build/load the application images
  EG_VERSION          Envoy Gateway version (default $EG_VERSION)
  HTTP_PORT=8080 HTTPS_PORT=8443
                      host ports to use when 80/443 cannot be bound (rootless
                      Docker/Podman). Applied when the kind cluster is created;
                      every URL then carries the port (http://angular.$BASE_DOMAIN:8080).
                      Only 80/8080 and 443/8443 are supported (the Envoy Service
                      exposes 8080/8443 as in-cluster aliases, see deploy/gateway).
  BASE_DOMAIN, SCHEME see scripts/render.sh

steps
  1. kind create cluster (deploy/kind/kind-config.yaml) if it does not exist
  2. install Envoy Gateway \$EG_VERSION if it is not installed
  3. apply deploy/gateway (GatewayClass, EnvoyProxy, Gateway) and wait for Programmed
     (+ deploy/tls/gateway-https.yaml again if scripts/tls-setup.sh was run before)
  4. scripts/coredns-rewrite.sh  (*.127.0.0.1.nip.io -> Envoy, for pods)
  5. scripts/build.sh            (unless SKIP_BUILD=1)
  6. scripts/deploy.sh \$IDP
USAGE
}
usage_if_help "${1:-}"
need docker kind kubectl curl jq openssl
docker info >/dev/null 2>&1 || die "docker is not running or not accessible for this user"
[[ "$HTTP_PORT" == 80 || "$HTTP_PORT" == 8080 ]] || die "HTTP_PORT must be 80 or 8080 (got $HTTP_PORT) - see --help"
[[ "$HTTPS_PORT" == 443 || "$HTTPS_PORT" == 8443 ]] || die "HTTPS_PORT must be 443 or 8443 (got $HTTPS_PORT) - see --help"

if [[ -r /proc/sys/fs/inotify/max_user_instances ]] && (( $(cat /proc/sys/fs/inotify/max_user_instances) < 512 )); then
  warn "fs.inotify.max_user_instances is low; if pods log 'too many open files' run: sudo sysctl fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288"
fi

# 1. cluster -----------------------------------------------------------------
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  ok "kind cluster $CLUSTER_NAME exists"
  # Port mappings are fixed at creation time: tell the user if they differ from HTTP_PORT.
  mapped="$(docker port "${CLUSTER_NAME}-control-plane" 30080/tcp 2>/dev/null | head -1 || true)"
  if [[ -n "$mapped" && "${mapped##*:}" != "$HTTP_PORT" ]]; then
    warn "the existing cluster maps host port ${mapped##*:} (not HTTP_PORT=$HTTP_PORT); run scripts/down.sh first to change it"
  fi
else
  kind_config="$REPO_ROOT/deploy/kind/kind-config.yaml"
  if [[ "$HTTP_PORT" != 80 || "$HTTPS_PORT" != 443 ]]; then
    # Same config with the host ports swapped (the NodePorts inside stay 30080/30443).
    kind_config="$(mktemp --suffix=.yaml)"
    sed -e "s/hostPort: 80$/hostPort: $HTTP_PORT/" -e "s/hostPort: 443$/hostPort: $HTTPS_PORT/" \
      "$REPO_ROOT/deploy/kind/kind-config.yaml" > "$kind_config"
  fi
  log "creating kind cluster $CLUSTER_NAME (host ports $HTTP_PORT/$HTTPS_PORT -> NodePorts 30080/30443)"
  kind create cluster --name "$CLUSTER_NAME" --config "$kind_config"
  [[ "$kind_config" == "$REPO_ROOT"/* ]] || rm -f "$kind_config"
fi
k cluster-info >/dev/null

# 2. Envoy Gateway -----------------------------------------------------------
if k -n envoy-gateway-system get deployment envoy-gateway >/dev/null 2>&1; then
  ok "Envoy Gateway is installed"
else
  log "installing Envoy Gateway $EG_VERSION (bundles the Gateway API CRDs)"
  k apply --server-side -f "https://github.com/envoyproxy/gateway/releases/download/${EG_VERSION}/install.yaml"
fi
k -n envoy-gateway-system wait deployment/envoy-gateway --for=condition=Available --timeout=300s
k wait --for=condition=Established crd/gateways.gateway.networking.k8s.io crd/securitypolicies.gateway.envoyproxy.io --timeout=60s >/dev/null

# 3. Gateway -----------------------------------------------------------------
if k -n ingress get deployment traefik >/dev/null 2>&1; then
  die "Ingress mode is active (Traefik owns NodePorts 30080/30443). Run scripts/ingress-mode.sh off first, or use scripts/deploy.sh <idp> to (re)deploy the applications."
fi
log "applying deploy/gateway"
k apply -k "$REPO_ROOT/deploy/gateway"
# kubectl apply replaced the listener list: restore the https listener if TLS mode was set up.
if k -n k8sgateway get secret k8sgateway-tls >/dev/null 2>&1; then
  log "TLS mode detected (Secret k8sgateway-tls): re-applying the https listener"
  sed "s/\*\.127\.0\.0\.1\.nip\.io/*.${BASE_DOMAIN}/" "$REPO_ROOT/deploy/tls/gateway-https.yaml" | k apply -f -
fi
log "waiting for Gateway k8sgateway/main to be programmed"
k -n k8sgateway wait gateway/main --for=condition=Programmed --timeout=300s

# 4. DNS ---------------------------------------------------------------------
log "pointing *.$BASE_DOMAIN inside the cluster at the Envoy proxy Service"
"$REPO_ROOT/scripts/coredns-rewrite.sh"

# 5. images ------------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  warn "SKIP_BUILD=1: not building images"
else
  "$REPO_ROOT/scripts/build.sh"
fi

# 6. applications + IdP ------------------------------------------------------
"$REPO_ROOT/scripts/deploy.sh" "$IDP"

log "checking the host can reach the gateway"
wait_http "$(url_for api /api/public)" 60 || warn "$(url_for api /api/public) does not answer 200 yet; see docs/14-troubleshooting.md"
echo
"$REPO_ROOT/scripts/urls.sh"
