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

## Shipping a fix

The day-to-day maintainer loop. This is the routine you'll run dozens of times for every governance/release dance once.

1. Branch from `main`. Use a [Conventional Commits](https://www.conventionalcommits.org/) prefix in the branch name so intent is readable from `gh pr list`:
   - `fix/<slug>` for bug fixes
   - `feat/<slug>` for features
   - `docs/<slug>` for docs-only changes
   - `chore/<slug>`, `refactor/<slug>`, `ci/<slug>`, `test/<slug>` as appropriate
2. Make the change. Keep PRs scoped — one logical concern per PR.
3. Commit with a Conventional Commits subject. Signed commits are required (`git commit -S`); the branch ruleset will reject unsigned commits once branch protection is on.
4. Push and open a PR against `main`. CI runs four required checks:
   - `lint` (actionlint + markdownlint + shellcheck + link-check + eslint)
   - `build-and-test` (tsc + vitest)
   - `cdk-synth` (cdk synth + cdk-nag)
   - `scan` (gitleaks + trivy + osv-scanner)
5. Request review from a CODEOWNER (`@foolswithtools/maintainers`). One approval is required. Resolve all conversations.
6. Squash-merge once green. Delete-branch-on-merge is enabled, so the feature branch goes away automatically. Linear history is enforced — don't create merge commits.
7. release-please reacts to the new commit on `main`. It opens (or updates) a release PR if the merged commit includes `feat:` or `fix:` (or any `!`-flagged breaking change). `chore:`, `docs:`, `refactor:`, `test:`, and `ci:` do not bump the version on their own.
8. To cut a release, merge the open release-please PR. See "Cutting a release" above.

## Known CI quirks

These are operate-around-not-fix items. If you "fix" them you'll likely break the workaround.

- **`CHANGELOG.md` is excluded from markdownlint.** PR #34 added `!CHANGELOG.md` to the markdownlint globs in `.github/workflows/ci-lint.yml`. The file is regenerated by release-please from Conventional Commits and is not expected to be lint-clean (long header lines, raw URLs, no terminal newline between sections). Don't edit it by hand and don't try to satisfy markdownlint on it — your changes are clobbered on the next release.
- **`secrets.GITHUB_TOKEN` anti-loop.** GitHub deliberately does not trigger workflow runs from PRs opened or pushed by the default `GITHUB_TOKEN`. This affects PRs from release-please, and dependabot in some configurations. Symptom: a bot-authored PR sits with no checks reported (status shows "Expected — Waiting for status to be reported"). Workaround: close the PR and immediately reopen it from your own (non-bot) identity — the reopen event re-fires `pull_request` from a human actor and CI runs. This is GitHub-platform behavior, not a config choice in this repo. (See the `release.yml` header comment for the long-form explanation.)
- **`cdk-nag` suppressions require explicit justification.** Every `NagSuppressions.addResourceSuppressions(...)` call must include a human-readable `reason` string in the suppression — see the existing pattern in `infra/lib/stacks/network-stack.ts`. When a PR adds a new suppression, the PR description must include one sentence explaining why the suppression is acceptable (threat model, compensating control, or upstream limitation). Reviewers should reject suppressions that say "false positive" without context.

## PR-from-fork triage

External contributors open PRs from forks. Two GitHub events look similar but have very different security postures.

- **`pull_request` (default).** Runs in the fork's context. The `GITHUB_TOKEN` is read-only. No repository secrets are exposed. Untrusted code cannot exfiltrate credentials or escalate. This is the safe default for `lint`, `build-and-test`, `cdk-synth` (against synthesized templates only), and `scan`.
- **`pull_request_target`.** Runs in the **upstream** repo's context with full secrets and a writable token, but checks out the **fork's** code by default. Treat this as remote code execution against your repo. Only use it for trusted operations that don't execute fork code: applying labels, posting comments, validating PR metadata. Never use it to run a fork's tests, build steps, or CDK synth that imports fork TypeScript.

Operating procedure for a first-time contributor PR:

1. The org-level "approve workflows for first-time contributors" gate (`approve_pull_request_reviews_from_first_time_contributors: true`) holds the workflow at "Waiting for approval." A maintainer must click "Approve and run" the first time.
2. Before approving, skim the PR diff for anything that touches workflows, CI scripts, `package.json` postinstall hooks, or anything network-fetching at build time. If you see those, scrutinize harder or ask the contributor to split the change.
3. Approve the run. Re-review subsequent runs only if the diff materially changes (new dependencies, new workflow edits).
4. AWS-touching workflows (`smoke-test.yml`, `pod-up.yml`, `cluster-up.yml`, `bootstrap-aws.yml`) are gated by `if: github.repository == 'foolswithtools/cloud-dev-pods'` — fork PRs cannot trigger them at all. If you ever need to validate a fork's CDK changes against real AWS, do it on the smoke fork (`clostaunau/cloud-dev-pods-smoke`) under your own credentials, not by relaxing the gate.
5. Never check out fork code to your laptop and run scripts against it without sandboxing — `npm install` alone runs arbitrary postinstall hooks. Use a throwaway container or codespace.

## Stale release-please PR recovery

A release PR has been sitting for days/weeks, `main` has moved, and you're not sure if it's safe to merge. Triage in this order.

1. **Check divergence.** Run:

   ```bash
   gh pr view <num> --json mergeable,mergeStateStatus,headRefOid,baseRefOid
   ```

   If `mergeStateStatus` is `BEHIND` or `mergeable` is `CONFLICTING`, the PR needs a refresh.
2. **Just a stale base?** Comment `release-please --force-push` on the PR. The release-please bot listens for that exact phrase and recreates the release branch from current `main`, picking up any new Conventional Commits since the PR was opened. Don't `git rebase` it manually.
3. **CI never ran (anti-loop)?** Symptom: checks show "Expected — Waiting for status to be reported" with no runs queued. Close the PR and reopen it from your own identity. See "Known CI quirks" above.
4. **Manifest drift?** If `.release-please-manifest.json` was hand-edited (someone bumped a version manually, or a sync-upstream merge mangled it), revert that file to its last known good state on `main` and let release-please regenerate the PR on the next push. Never patch the manifest inside the release PR — release-please ignores hand edits and they confuse the next run.
5. **Bot's commits are wrong?** Don't amend or force-push to the release-please branch. Its commits are deterministically regenerated from Conventional Commits + manifest state. The right fix is upstream of release-please: either (a) fix the offending Conventional Commit on `main` with a follow-up `fix:` commit, or (b) close the release PR — release-please will reopen a fresh one on the next push to `main`.

Rule of thumb: never treat a release-please PR as a normal feature branch. It's bot-owned, regenerable state — your job is to merge it or to fix the inputs that produce it.

## Time-bombed entries (calendar reminders)

Some maintenance items have a hard-coded date attached and will start failing CI or affecting users when that date passes. Track them here so they're discoverable from one place.

| Date | Item | Action |
|---|---|---|
| 2026-08-31 | `osv-scanner.toml` ignores `GHSA-q3j6-qgpj-74h6` and `GHSA-v39h-62p7-jpjc` (fast-uri@3.1.0 bundled inside aws-cdk-lib) — `scan` will fail every PR after expiry. | Bump aws-cdk-lib if it now bundles fast-uri ≥ 3.1.2 and remove the two ignores; otherwise extend the date or escalate. See pinned issue #45 for the full action plan. |
| 2026-12-31 | `osv-scanner.toml` ignores `GHSA-67mh-4wv8-2f99` (esbuild) and `GHSA-4w7w-66w2-5vf9` (vite). Dev-only, scoped to vitest's transitive vite/esbuild. | Re-evaluate after the next vitest/vite bump (Dependabot's `dev` group). Remove the ignores once the lockfile resolves to a fixed version. |

When you add a new time-bombed entry — a suppression with `ignoreUntil`, a hard-coded date in code, a deferred upstream issue, an ALB/Service Quotas raise that auto-expires — add a row here AND, for high-impact items, file a pinned issue with full context. The table is a quick scan; the issue is the action plan.
