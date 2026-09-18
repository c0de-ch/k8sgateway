#!/usr/bin/env bash
# Build the application images and load them into the kind cluster.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/build.sh [app ...]

  app   mock-idp | angular-app | nextjs-app | rest-api | graphql-api (default: all)

Builds apps/<app> as k8sgateway/<app>:dev (multi-stage Dockerfiles, no host
toolchain needed) and loads the image into the kind cluster "$CLUSTER_NAME".
Running pods keep the old image; scripts/switch-idp.sh or
  kubectl -n k8sgateway rollout restart deployment/<app>
picks up the new one.
USAGE
}
usage_if_help "${1:-}"
need docker kind
apps=("$@"); (( ${#apps[@]} )) || apps=("${APPS[@]}")

kind_load() { # kind load, with the image-archive fallback needed on Docker >= 25 with the containerd image store
  local image="$1" tar
  if kind load docker-image "$image" --name "$CLUSTER_NAME" >/dev/null 2>&1; then return; fi
  tar="$(mktemp --suffix=.tar)"
  docker image save --platform "linux/$(docker version --format '{{.Server.Arch}}')" -o "$tar" "$image"
  kind load image-archive "$tar" --name "$CLUSTER_NAME"
  rm -f "$tar"
}

for app in "${apps[@]}"; do
  dir="$REPO_ROOT/apps/$app"
  [[ -f "$dir/Dockerfile" ]] || { warn "skipping $app: $dir/Dockerfile not found"; continue; }
  image="k8sgateway/$app:dev"
  log "building $image"
  docker build -t "$image" "$dir"
  log "loading $image into kind cluster $CLUSTER_NAME"
  kind_load "$image"
  ok "$image"
done
