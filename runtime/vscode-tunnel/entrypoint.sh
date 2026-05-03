#!/usr/bin/env bash
set -euo pipefail

: "${POD_NAME:?POD_NAME must be set by the ECS task override}"

exec bash -lc "/opt/vscode-cli/code tunnel --accept-server-license-terms --name ${POD_NAME}"
