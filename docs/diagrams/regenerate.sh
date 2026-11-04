#!/usr/bin/env bash
# Regenerate every diagram under docs/diagrams/ from its source in <area>/src/.
#
# Usage:
#   FIREWORKS_TECH_GRAPH=/path/to/fireworks-tech-graph docs/diagrams/regenerate.sh [--check]
#
#   --check  render into a temp dir and diff against the committed SVGs instead
#            of overwriting them (exit 1 if any differ).
#
# Requirements: python3 with cairosvg (validation renders through it), and a
# checkout of fireworks-tech-graph 1.2.0 for the JSON specs. The hand-written
# .py generators need only the Python standard library. See README.md#regenerating.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK=true
fi

# JSON specs rendered by fireworks-tech-graph's template generator: <area>/<slug> <template type>.
JSON_SPECS=(
  "system/system-context architecture"
  "infrastructure/aws-deployment-topology architecture"
  "infrastructure/cdk-stack-composition architecture"
  "operations/workflows-and-iam-roles architecture"
  "operations/first-run-setup-flow flowchart"
  "operations/cluster-down-guards flowchart"
  "operations/upstream-sync data-flow"
  "runtime/pod-task-anatomy-browser architecture"
  "runtime/pod-task-anatomy-tunnel architecture"
  "runtime/runtime-image-build flowchart"
  "runtime/config-pipeline data-flow"
)

# Hand-written generators (sequence, state-machine, decision-diamond diagrams the
# template generator cannot express). Each writes ../<slug>.svg next to itself.
PY_SPECS=(
  "auth/browser-request-path"
  "auth/browser-auth-providers"
  "auth/tunnel-device-code-flow"
  "auth/secrets-and-trust"
  "pod-lifecycle/pod-up-sequence"
  "pod-lifecycle/pod-down-and-idle-reaper"
  "pod-lifecycle/pod-state-machine"
)

WORK="$HERE"
if $CHECK; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  # Copy the tree so the .py generators write into the temp copy.
  cp -R "$HERE"/. "$WORK"/
fi

export PYTHONDONTWRITEBYTECODE=1

if [[ ${#JSON_SPECS[@]} -gt 0 ]]; then
  : "${FIREWORKS_TECH_GRAPH:?set FIREWORKS_TECH_GRAPH to a fireworks-tech-graph checkout}"
  for entry in "${JSON_SPECS[@]}"; do
    read -r path type <<<"$entry"
    python3 "$FIREWORKS_TECH_GRAPH/scripts/generate-from-template.py" "$type" \
      "$WORK/$path.svg" "$(cat "$HERE/$(dirname "$path")/src/$(basename "$path").json")" >/dev/null
    echo "rendered $path.svg ($type)"
  done
fi

for path in "${PY_SPECS[@]}"; do
  python3 "$WORK/$(dirname "$path")/src/$(basename "$path").py" >/dev/null
  echo "rendered $path.svg (python)"
done

if [[ -n "${FIREWORKS_TECH_GRAPH:-}" ]]; then
  for entry in "${JSON_SPECS[@]}" "${PY_SPECS[@]}"; do
    read -r path _ <<<"$entry"
    "$FIREWORKS_TECH_GRAPH/scripts/validate-svg.sh" "$WORK/$path.svg" >/dev/null \
      || { echo "validation failed: $path.svg" >&2; exit 1; }
  done
  echo "all diagrams pass validate-svg.sh"
fi

if $CHECK; then
  status=0
  for entry in "${JSON_SPECS[@]}" "${PY_SPECS[@]}"; do
    read -r path _ <<<"$entry"
    if ! diff -q "$HERE/$path.svg" "$WORK/$path.svg" >/dev/null; then
      echo "differs: $path.svg" >&2
      status=1
    fi
  done
  exit "$status"
fi
