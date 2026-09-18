#!/usr/bin/env bash
# Print the URLs and demo users of the running installation.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { echo "usage: scripts/urls.sh   (honours BASE_DOMAIN / SCHEME / PORT_SUFFIX)"; }
usage_if_help "${1:-}"

idp="$(detect_idp 2>/dev/null || echo none)"
printf '%sApplications%s (IdP currently configured: %s)\n' "$C_BOLD" "$C_RESET" "$idp"
printf '  Angular SPA        %s\n' "$(url_for angular)"
printf '  Next.js BFF        %s\n' "$(url_for next)"
printf '  REST API           %s\n' "$(url_for api /api/public)"
printf '  GraphQL API        %s\n' "$(url_for graphql /graphql)"
printf '%sIdentity providers%s\n' "$C_BOLD" "$C_RESET"
printf '  mock IdP           %s   (dashboard, token debugger)\n' "$(url_for idp)"
printf '  Keycloak           %s   (admin console /admin, admin/admin)\n' "$(url_for keycloak)"
printf '%sDemo users%s (password = user name)\n' "$C_BOLD" "$C_RESET"
printf '  alice  admin, user     bob  user     carol  (no roles)\n'
# shellcheck disable=SC2016  # the $(...) is meant literally, it is a hint for the reader
printf '\n  TOKEN=$(scripts/get-token.sh alice)   # then: curl -H "Authorization: Bearer $TOKEN" %s\n' "$(url_for api /api/me)"
