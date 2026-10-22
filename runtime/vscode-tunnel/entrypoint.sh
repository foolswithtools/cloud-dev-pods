#!/usr/bin/env bash
set -euo pipefail

: "${POD_NAME:?POD_NAME must be set by the ECS task override}"

# Account type for the device-code login: auth.tunnel.provider in
# config/config.yaml, or pod-up's tunnel_provider input. Set by pod-manager.
TUNNEL_PROVIDER="${TUNNEL_PROVIDER:-github}"
case "$TUNNEL_PROVIDER" in
  github|microsoft) ;;
  *)
    echo "TUNNEL_PROVIDER must be github or microsoft (got \"${TUNNEL_PROVIDER}\")" >&2
    exit 64
    ;;
esac

# `code` is /opt/vscode-cli/code (on PATH via the Dockerfile). `user show`
# exits non-zero when no login is stored. The login prints the device-code
# prompt that scripts/tunnel-poll-logs.ts picks out of CloudWatch Logs.
if ! code tunnel user show >/dev/null 2>&1; then
  code tunnel user login --provider "$TUNNEL_PROVIDER"
fi

exec code tunnel --accept-server-license-terms --name "$POD_NAME"
