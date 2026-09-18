#!/usr/bin/env bash
# Render an overlay to stdout: kubectl kustomize + (optional) hostname rewrite.
#
# The manifests spell hostnames out literally (angular.127.0.0.1.nip.io, ...).
# When BASE_DOMAIN, SCHEME or PORT_SUFFIX differ from the defaults, the whole
# deploy/ tree is copied to a temp dir, rewritten with sed and rendered from
# there, so generated ConfigMap hashes stay consistent with their content.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<USAGE
usage: scripts/render.sh <overlay>

  overlay   mock | keycloak | entra | oracle, or any directory under deploy/overlays/
            (e.g. entra.local - *.local directories are git-ignored)

environment
  BASE_DOMAIN   hostname suffix       (default 127.0.0.1.nip.io)
  SCHEME        http | https          (default http; https needs scripts/tls-setup.sh)
  HTTP_PORT, HTTPS_PORT   host ports  (default 80/443; 8080/8443 on rootless Docker,
                see scripts/up.sh) - the port of the active scheme is appended to
                every URL in the manifests (issuer, API_URL, CORS origins, ...)
  PORT_SUFFIX   e.g. ":8080"          (explicit override of that suffix)

Refuses to render an overlay that still contains <PLACEHOLDERS>.
USAGE
}
usage_if_help "${1:-}"
[[ $# -eq 1 ]] || { usage >&2; exit 2; }

overlay="$1"
overlay_dir="$REPO_ROOT/deploy/overlays/$overlay"
[[ -d "$overlay_dir" ]] || die "overlay not found: $overlay_dir (available: $(find "$REPO_ROOT/deploy/overlays" -mindepth 1 -maxdepth 1 -type d -printf '%f '))"

# Placeholder guard: entra/oracle ship <TENANT_ID>-style values that must be replaced first.
# (only outside of # comments, so env files may mention placeholders in their comments)
if grep -rlE '^[^#]*<[A-Z_]+>' "$overlay_dir" --include='*.env' --include='*.json' >/dev/null 2>&1; then
  {
    printf '%serror%s overlay "%s" still contains placeholders:\n' "$C_RED" "$C_RESET" "$overlay"
    grep -rnE '^[^#]*<[A-Z_]+>' "$overlay_dir" --include='*.env' --include='*.json' | grep -oE '^[^:]+:[0-9]+:|<[A-Z_]+>' | paste -d' ' - - | sort -u | sed 's/^/  /'
    printf '\nReplace them with the values from your tenant (see %s/README.md), e.g.\n' "$overlay_dir"
    printf '  cp -r %s %s.local && sed -i "s/<TENANT_ID>/.../g" %s.local/*\n' "$overlay_dir" "$overlay_dir" "$overlay_dir"
    printf 'and deploy that copy: scripts/deploy.sh %s.local\n' "$overlay"
  } >&2
  exit 1
fi

if [[ "$BASE_DOMAIN" == "127.0.0.1.nip.io" && "$SCHEME" == "http" && -z "$PORT_SUFFIX" ]]; then
  exec kubectl kustomize "$overlay_dir"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -r "$REPO_ROOT/deploy" "$tmp/deploy"
# 1) URLs: scheme + label + domain (+ port); 2) bare hostnames (HTTPRoute, KC_HOSTNAME is a URL and hit by 1).
find "$tmp/deploy" -type f \( -name '*.yaml' -o -name '*.env' -o -name '*.json' \) -exec sed -i -E \
  -e "s#http://([a-z0-9-]+)\.127\.0\.0\.1\.nip\.io#${SCHEME}://\1.${BASE_DOMAIN}${PORT_SUFFIX}#g" \
  -e "s#\.127\.0\.0\.1\.nip\.io#.${BASE_DOMAIN}#g" {} +
kubectl kustomize "$tmp/deploy/overlays/$overlay"
