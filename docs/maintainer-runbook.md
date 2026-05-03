# Maintainer runbook

For the foolswithtools maintainers.

## Re-applying repo settings

```bash
scripts/maintainer/apply-repo-settings.sh
```

Idempotent. Re-asserts every `gh repo edit` flag, security toggle, Actions allowlist, and (Phase 14) branch protection ruleset. Run after any upstream rename, ownership transfer, or when GitHub adds new toggles.

## Cutting a release

`release-please` does this automatically on push to `main`. Look for the auto-opened "release-please:" PR; merge it to publish.

To force a release: comment `/release-please:run` on the PR. To skip: don't merge.

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
