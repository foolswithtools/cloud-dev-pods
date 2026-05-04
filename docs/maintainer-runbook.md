# Maintainer runbook

For the foolswithtools maintainers.

## Re-applying repo settings

The script idempotently asserts every `gh repo edit` flag, security toggle, Actions allowlist, workflow permissions, and (gated) branch + tag protection ruleset. Run as a repo admin (member of `foolswithtools` with admin role) after any drift, ownership transfer, or new GitHub toggle.

```bash
# Defaults: applies everything except branch protection (gated; see below).
scripts/maintainer/apply-repo-settings.sh

# Activate branch + tag protection (do this once you're ready for PRs to require approval).
APPLY_BRANCH_PROTECTION=yes scripts/maintainer/apply-repo-settings.sh
```

### What the script enforces

- `gh repo edit` flags: template flag on, discussions on, squash-merge only, delete branch on merge.
- `security_and_analysis`: secret scanning + push protection + validity checks + non-provider patterns + Dependabot security updates, all enabled.
- Private vulnerability reporting: enabled.
- Code scanning default setup: configured with the extended query suite (skipped if GHAS isn't available).
- Actions: selected allowlist only (the patterns in `scripts/maintainer/apply-repo-settings.sh`).
- Workflow permissions: default `read`, `can_approve_pull_request_reviews: true` (release-please needs this).
- Main branch ruleset (gated): 1 approving review + dismiss stale + CODEOWNERS + last-push approval + linear history + 4 required checks (`lint`, `build-and-test`, `cdk-synth`, `scan`) + no force pushes / deletions.
- Tag ruleset (gated): `v*.*.*` tags can't be force-pushed or deleted.

### Activation order

1. Land Phase 14 PR (this).
2. Run `scripts/maintainer/apply-repo-settings.sh` once **without** `APPLY_BRANCH_PROTECTION=yes` — re-asserts everything else.
3. Wait until at least Phase 15 has merged so all the workflow status check names are stable.
4. Then run `APPLY_BRANCH_PROTECTION=yes scripts/maintainer/apply-repo-settings.sh` to activate the rulesets.

After step 4, every PR needs:

- a passing `lint` + `build-and-test` + `cdk-synth` + `scan` check
- one approval from a CODEOWNER (currently `@clostaunau`)
- linear history (rebase or squash, no merge commits)

### One-time org settings (org-owner only)

A few settings can't be set at repo level. The org owner needs to:

1. Create the `@foolswithtools/maintainers` team and add both maintainers. Then update `.github/CODEOWNERS` to use `@foolswithtools/maintainers` instead of individual handles.
2. Enable "Allow GitHub Actions to create and approve pull requests" at <https://github.com/organizations/foolswithtools/settings/actions> (release-please needs this — see "Cutting a release" below).

## Cutting a release

`release-please` does this automatically on push to `main`. Look for the auto-opened "release-please--branches--main--components--cloud-dev-pods" PR; merge it to publish.

To force a release: comment `/release-please:run` on the PR. To skip: don't merge.

### One-time org setting

Release-please's PR creation needs **"Allow GitHub Actions to create and approve pull requests"** enabled at the org level. **Org-owner-only action**:

1. <https://github.com/organizations/foolswithtools/settings/actions> → "Workflow permissions"
2. Check "Allow GitHub Actions to create and approve pull requests".
3. Save.

If this isn't enabled, release-please successfully creates the release branch + bump commit but fails at PR creation (`GitHub Actions is not permitted to create or approve pull requests`). Manual workaround: open the PR via `gh pr create --head release-please--branches--main--components--cloud-dev-pods` once.

Alternative: use a fine-grained PAT scoped to `foolswithtools/cloud-dev-pods` with `Pull requests: write` + `Contents: write`, set as `RELEASE_PAT` secret, swap `secrets.GITHUB_TOKEN` for `secrets.RELEASE_PAT` in `release.yml`.

## Refreshing pricing data

`pricing/fargate-prices.json` is hand-curated. To refresh:

(Phase 13: a `pricing-refresh.yml` workflow will pull from the AWS Pricing API and open a PR.)

## Handling sync-upstream PRs in users' repos

If a user reports a sync-upstream conflict, ask:

1. Did they modify `.upstream-sync.toml`? (Maybe they re-classified files.)
2. Did they edit a `[merged]` file? (Diff3 markers expected.)
3. Did they edit a `[tracked]` file? (Their changes will be lost — recommend they move it to `[user]` via local override.)

## Promoting a contributor

External contributors should have their PRs gated by the `approve_pull_request_reviews_from_first_time_contributors` flag. To grant trust, add them to the `@foolswithtools/maintainers` team (org-owner action only).
