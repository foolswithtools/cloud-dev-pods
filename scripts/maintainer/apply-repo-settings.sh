#!/usr/bin/env bash
# Idempotent re-assertion of foolswithtools/cloud-dev-pods settings.
# Run by a repo admin after any drift, ownership transfer, or new GitHub
# toggle. Safe to run repeatedly.
#
# Branch protection is GATED by an env flag because once active, all PRs
# require reviewer approval — including the merge of any subsequent
# Phase-15+ work. Set APPLY_BRANCH_PROTECTION=yes when you're ready.
#
# Usage:
#   scripts/maintainer/apply-repo-settings.sh
#   APPLY_BRANCH_PROTECTION=yes scripts/maintainer/apply-repo-settings.sh
#
# Required: `gh` CLI authenticated as a user with admin on $REPO.

set -euo pipefail

REPO="${REPO:-foolswithtools/cloud-dev-pods}"
APPLY_BRANCH_PROTECTION="${APPLY_BRANCH_PROTECTION:-no}"

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { printf '\033[1;32m  v\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }

log "Re-asserting settings on $REPO"

# 1. Repo-level flags via gh repo edit.
log "gh repo edit flags"
gh repo edit "$REPO" \
  --template \
  --enable-discussions \
  --delete-branch-on-merge \
  --enable-squash-merge \
  --enable-merge-commit=false \
  --enable-rebase-merge=false \
  --enable-issues \
  --enable-projects=false \
  --enable-wiki=false \
  --homepage "https://github.com/$REPO"
ok "flags applied"

# 2. Security & analysis (secret scanning, push protection, dependabot).
log "security_and_analysis"
gh api -X PATCH "/repos/$REPO" --input - >/dev/null <<'EOF'
{
  "security_and_analysis": {
    "secret_scanning": {"status": "enabled"},
    "secret_scanning_push_protection": {"status": "enabled"},
    "secret_scanning_validity_checks": {"status": "enabled"},
    "secret_scanning_non_provider_patterns": {"status": "enabled"},
    "dependabot_security_updates": {"status": "enabled"}
  }
}
EOF
ok "secret scanning + dependabot"

# 3. Private vulnerability reporting.
log "private vulnerability reporting"
gh api -X PUT "/repos/$REPO/private-vulnerability-reporting" >/dev/null
ok "enabled"

# 4. Code scanning default setup (CodeQL).
log "code scanning default setup"
if gh api -X PATCH "/repos/$REPO/code-scanning/default-setup" --input - >/dev/null 2>/dev/null <<'EOF'
{ "state": "configured", "query_suite": "extended" }
EOF
then
  ok "configured (extended query suite)"
else
  warn "code scanning default setup unavailable (may need GHAS or manual click-through)"
fi

# 5. Actions: selected allowlist only (no marketplace free-for-all).
log "Actions: selected allowlist"
gh api -X PUT "/repos/$REPO/actions/permissions" --input - >/dev/null <<'EOF'
{ "enabled": true, "allowed_actions": "selected" }
EOF
gh api -X PUT "/repos/$REPO/actions/permissions/selected-actions" --input - >/dev/null <<'EOF'
{
  "github_owned_allowed": true,
  "verified_allowed": false,
  "patterns_allowed": [
    "aws-actions/*",
    "peter-evans/create-pull-request@*",
    "googleapis/release-please-action@*",
    "aquasecurity/trivy-action@*",
    "gitleaks/gitleaks-action@*",
    "google/osv-scanner-action@*",
    "lycheeverse/lychee-action@*",
    "rhysd/actionlint@*",
    "DavidAnson/markdownlint-cli2-action@*",
    "ludeeus/action-shellcheck@*"
  ]
}
EOF
ok "allowlist applied"

# 6. Workflow permissions: read default; allow workflows to create/approve PRs
#    (release-please depends on this).
log "Actions workflow permissions"
gh api -X PUT "/repos/$REPO/actions/permissions/workflow" --input - >/dev/null <<'EOF'
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": true }
EOF
ok "default read; PR creation allowed"

# 7. Branch protection ruleset (gated).
if [[ "$APPLY_BRANCH_PROTECTION" == "yes" ]]; then
  log "main branch protection (APPLY_BRANCH_PROTECTION=yes)"

  # Delete any existing ruleset with this name first so re-runs are clean.
  EXISTING=$(gh api "/repos/$REPO/rulesets" --jq '.[] | select(.name=="main protection") | .id' || true)
  if [[ -n "$EXISTING" ]]; then
    gh api -X DELETE "/repos/$REPO/rulesets/$EXISTING" >/dev/null
    ok "deleted existing 'main protection' ruleset (id=$EXISTING)"
  fi

  gh api -X POST "/repos/$REPO/rulesets" --input - >/dev/null <<'EOF'
{
  "name": "main protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "lint" },
          { "context": "build-and-test" },
          { "context": "cdk-synth" },
          { "context": "scan" }
        ]
      }
    }
  ],
  "bypass_actors": []
}
EOF
  ok "main protection active"

  log "tag protection (v*.*.*)"
  EXISTING=$(gh api "/repos/$REPO/rulesets" --jq '.[] | select(.name=="release tags") | .id' || true)
  if [[ -n "$EXISTING" ]]; then
    gh api -X DELETE "/repos/$REPO/rulesets/$EXISTING" >/dev/null
  fi
  gh api -X POST "/repos/$REPO/rulesets" --input - >/dev/null <<'EOF'
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/tags/v*"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ],
  "bypass_actors": []
}
EOF
  ok "tag protection active"
else
  warn "skipping branch protection - set APPLY_BRANCH_PROTECTION=yes to enable"
fi

log "done"
