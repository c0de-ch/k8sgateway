#!/usr/bin/env bash
# Swap the Gateway API setup (Envoy Gateway) for a classic Ingress controller
# (Traefik v3) and back. Both bind the same NodePorts 30080/30443, so only one
# of them runs at a time. The applications, the IdPs and their configuration
# are untouched: only the piece that routes http://<name>.127.0.0.1.nip.io to
# a Service changes. See docs/16-ingress.md.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/ingress-mode.sh on | off | status

  on      delete the Gateway, install Traefik (deploy/ingress/traefik.yaml) and
          one Ingress per hostname (deploy/ingress/ingresses.yaml), point the
          in-cluster DNS rewrite at the Traefik Service
  off     remove Traefik and the Ingress resources, re-create the Gateway and
          point the DNS rewrite at the Envoy proxy Service again
  status  print which of the two is active

Ingress mode is plain http; the TLS mode of deploy/tls belongs to the Gateway.
USAGE
}
usage_if_help "${1:-}"
[[ $# -eq 1 ]] || { usage >&2; exit 2; }
need kubectl curl

render_ingress() { # kustomize + the same hostname rewrite as scripts/render.sh
  if [[ "$BASE_DOMAIN" == "127.0.0.1.nip.io" ]]; then
    kubectl kustomize "$REPO_ROOT/deploy/ingress"
  else
    kubectl kustomize "$REPO_ROOT/deploy/ingress" | sed -E "s#\.127\.0\.0\.1\.nip\.io#.${BASE_DOMAIN}#g"
  fi
}

wait_gone() { # wait_gone <namespace> <kind/name> [seconds]
  local ns="$1" ref="$2" timeout="${3:-120}" start
  start=$(date +%s)
  while k -n "$ns" get "$ref" >/dev/null 2>&1; do
    (( $(date +%s) - start < timeout )) || die "$ns/$ref still exists after ${timeout}s"
    sleep 2
  done
}

envoy_svc() {
  k -n envoy-gateway-system get svc -l gateway.envoyproxy.io/owning-gateway-name=main,gateway.envoyproxy.io/owning-gateway-namespace=k8sgateway \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
}

case "$1" in
  status)
    if k -n ingress get deployment traefik >/dev/null 2>&1; then echo "ingress (Traefik)"; else echo "gateway (Envoy Gateway)"; fi
    ;;
  on)
    if k -n k8sgateway get secret k8sgateway-tls >/dev/null 2>&1; then
      warn "TLS mode is set up on the Gateway; Ingress mode serves plain http only (SCHEME=http)"
    fi
    if k -n k8sgateway get gateway main >/dev/null 2>&1; then
      log "deleting Gateway k8sgateway/main (frees NodePorts 30080/30443)"
      k -n k8sgateway delete gateway main --wait=true >/dev/null
      svc="$(envoy_svc)"
      [[ -z "$svc" ]] || wait_gone envoy-gateway-system "svc/$svc"
    fi
    log "installing Traefik and the Ingress resources (deploy/ingress)"
    render_ingress | k apply -f - >/dev/null
    k -n ingress rollout status deployment/traefik --timeout=180s
    log "pointing *.$BASE_DOMAIN inside the cluster at the Traefik Service"
    REWRITE_TARGET=traefik.ingress.svc.cluster.local "$REPO_ROOT/scripts/coredns-rewrite.sh"
    log "waiting for the applications to answer through the Ingress"
    wait_http "$(url_for api /api/public)" 90 || die "$(url_for api /api/public) does not answer through Traefik"
    k get ingress -A
    ok "Ingress mode active - the URLs are unchanged: $(url_for angular), $(url_for api /api/public), ..."
    ;;
  off)
    if k -n ingress get deployment traefik >/dev/null 2>&1; then
      log "removing Traefik and the Ingress resources"
      render_ingress | k delete -f - --ignore-not-found >/dev/null
      wait_gone ingress svc/traefik
    fi
    log "re-creating the Gateway (deploy/gateway)"
    k apply -k "$REPO_ROOT/deploy/gateway" >/dev/null
    if k -n k8sgateway get secret k8sgateway-tls >/dev/null 2>&1; then
      sed "s/\*\.127\.0\.0\.1\.nip\.io/*.${BASE_DOMAIN}/" "$REPO_ROOT/deploy/tls/gateway-https.yaml" | k apply -f - >/dev/null
    fi
    k -n k8sgateway wait gateway/main --for=condition=Programmed --timeout=300s >/dev/null
    "$REPO_ROOT/scripts/coredns-rewrite.sh"
    wait_http "$(url_for api /api/public)" 90 || die "$(url_for api /api/public) does not answer through the Gateway"
    ok "Gateway mode active"
    ;;
  *) usage >&2; exit 2 ;;
esac
