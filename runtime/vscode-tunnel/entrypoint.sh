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

# ECS sends SIGTERM on pod-down. Stop the tunnel, then unregister it so the
# account's slot is freed now rather than at the 30-day inactivity expiry
# (an account may register 10 tunnels; an 11th evicts a random unused one).
# Unregister runs after the tunnel exits so the running CLI can't re-create
# it. Both steps are bounded to fit the container's 30 s stopTimeout.
child=""
# shellcheck disable=SC2329 # invoked by the TERM trap
on_term() {
  trap - TERM
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$child" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  timeout 20 code tunnel unregister || true
  exit 0
}
trap on_term TERM

code tunnel --accept-server-license-terms --name "$POD_NAME" &
child=$!
status=0
wait "$child" || status=$?
exit "$status"
