#!/usr/bin/env bash
set -euo pipefail

# Phase 5: bind openvscode-server to localhost only; oauth2-proxy fronts it.
exec /home/.openvscode-server/bin/openvscode-server \
  --host 127.0.0.1 \
  --port 3000 \
  --without-connection-token
