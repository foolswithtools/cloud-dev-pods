#!/usr/bin/env bash
# Phase 14: idempotently re-apply foolswithtools/cloud-dev-pods repository settings.
# Run from any repo admin with `gh` authenticated as a user who has admin on this repo.
#
# Settings re-asserted:
#   - gh repo edit (template flag, merge style, features, homepage)
#   - PATCH security_and_analysis (secret scanning, push protection, dependabot)
#   - PUT private-vulnerability-reporting
#   - PUT actions/permissions (selected actions allowlist)
#   - PUT actions/permissions/workflow (default read, no PR review approval)
#   - PUT actions/permissions/selected-actions (allowlist patterns)
#   - PUT main branch protection ruleset (Phase 14)
set -euo pipefail

REPO="${REPO:-foolswithtools/cloud-dev-pods}"

echo "Re-applying repo settings on ${REPO} (Phase 14 — full implementation pending)..."
echo "TODO: implement after Phase 3 lands the CI status checks needed by branch protection."
