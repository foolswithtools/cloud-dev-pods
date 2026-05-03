#!/usr/bin/env bash
# Phase 5: container HEALTHCHECK.
# For browser pods: probes oauth2-proxy /ping (port 4180).
# For tunnel pods:  checks `code tunnel status` succeeds.
set -euo pipefail

if [[ "${POD_MODE:-browser}" == "tunnel" ]]; then
  /opt/vscode-cli/code tunnel status >/dev/null
else
  curl -fsS http://127.0.0.1:4180/ping >/dev/null
fi
