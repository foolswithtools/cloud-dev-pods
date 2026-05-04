# Maintainer runbook

For the foolswithtools maintainers.

## Re-applying repo settings

```bash
scripts/maintainer/apply-repo-settings.sh
```

Idempotent. Re-asserts every `gh repo edit` flag, security toggle, Actions allowlist, and (Phase 14) branch protection ruleset. Run after any upstream rename, ownership transfer, or when GitHub adds new toggles.

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
