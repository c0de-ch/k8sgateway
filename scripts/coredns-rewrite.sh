#!/usr/bin/env bash
# Make pods resolve *.${BASE_DOMAIN} (default *.127.0.0.1.nip.io) to the Envoy
# Gateway proxy Service, so the SAME issuer URL works from browsers and pods.
#
# Without this, a pod resolving idp.127.0.0.1.nip.io would get 127.0.0.1 and
# talk to itself. With it, CoreDNS rewrites the query name to the proxy
# Service ("answer auto" rewrites the response back so strict resolvers such
# as glibc and Go accept it) and Envoy routes on the unchanged Host header.
set -euo pipefail

BASE_DOMAIN="${BASE_DOMAIN:-127.0.0.1.nip.io}"
GATEWAY_NAME="${GATEWAY_NAME:-main}"
GATEWAY_NAMESPACE="${GATEWAY_NAMESPACE:-k8sgateway}"
EG_NAMESPACE="${EG_NAMESPACE:-envoy-gateway-system}"

svc="$(kubectl -n "$EG_NAMESPACE" get svc \
  -l "gateway.envoyproxy.io/owning-gateway-name=${GATEWAY_NAME},gateway.envoyproxy.io/owning-gateway-namespace=${GATEWAY_NAMESPACE}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$svc" ]]; then
  echo "error: no Envoy proxy Service found for Gateway ${GATEWAY_NAMESPACE}/${GATEWAY_NAME} yet" >&2
  exit 1
fi
target="${svc}.${EG_NAMESPACE}.svc.cluster.local"
escaped_domain="$(printf '%s' "$BASE_DOMAIN" | sed 's/\./\\./g')"

# Build the new Corefile: drop a previous k8sgateway block (idempotent), then
# insert ours right after the opening ".:53 {" line.
current="$(kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}')"
cleaned="$(printf '%s\n' "$current" | awk '
  /# k8sgateway-rewrite-begin/ {skip=1}
  !skip {print}
  /# k8sgateway-rewrite-end/ {skip=0}')"
export REWRITE_BLOCK="    # k8sgateway-rewrite-begin
    rewrite stop {
        name regex ^(.*)\\.${escaped_domain}\\.$ ${target}
        answer auto
    }
    # k8sgateway-rewrite-end"
# ENVIRON (not -v) so awk does not reinterpret the backslashes.
new="$(printf '%s\n' "$cleaned" | awk '{print} /^\.:53 \{/ && !done {print ENVIRON["REWRITE_BLOCK"]; done=1}')"

kubectl -n kube-system patch configmap coredns --type merge \
  -p "$(jq -n --arg c "$new" '{data:{Corefile:$c}}')" >/dev/null
kubectl -n kube-system rollout restart deployment/coredns >/dev/null
kubectl -n kube-system rollout status deployment/coredns --timeout=120s >/dev/null
echo "CoreDNS: *.${BASE_DOMAIN} -> ${target}"
