# ADR 0006: Tracked / Merged / User file taxonomy for upstream sync

## Status

Accepted (2026-05-03).

## Context

The repo is a template. Users fork it, customize, and need to receive upstream upgrades over time. Naive `git diff upstream/main` produces unmergeable PRs because users edit local-only files.

## Decision

Every path in the repo is classified in `.upstream-sync.toml` as one of:

- `[tracked]` — always overwritten from upstream. Conflicts impossible. Examples: `infra/lib/**`, `runtime/**`, `scripts/**`, ADRs.
- `[merged]` — three-way merge against `LAST_SYNCED_SHA → upstream → user HEAD` via `git merge-file --diff3`. Conflicts surface in the PR body. Examples: workflows users may tweak, `package.json`, `tsconfig.json`.
- `[user]` — never touched by sync. Examples: `infra/config.local.ts`, `infra/extensions.local.ts`, `cdk.context.json`, `.env*`, `.github/CODEOWNERS`.

## Consequences

- Combined with the extension-point pattern (`infra/extensions.local.ts`), this lets users customize without forking upstream code.
- `sync-upstream.yml` opens clean PRs that don't fight users on local-only state.
- Adding a new top-level file requires deciding its class. Default to `[tracked]` unless there's a reason.
- See `docs/extending.md` for how users should structure their customizations.

### Classification decision tree

When you add a new top-level file or directory, walk this tree top-down and stop at the first match:

1. Does the path contain user identity, secrets, AWS account/region context, or local-only state that must never leave the fork? (Examples: `.env*`, `cdk.context.json`, `infra/config.local.ts`, `.github/CODEOWNERS`.)
   - **Yes →** `[user]`. Sync never touches it.
2. Will users reasonably tweak this file as part of running the template? Workflows they edit to change runtime behavior, configs they extend, dependency manifests they add packages to. (Examples: `package.json`, `.github/workflows/pod-*.yml`, `.github/dependabot.yml`.)
   - **Yes →** `[merged]`. Three-way merge surfaces conflicts in the PR body.
3. Otherwise — constructs, runtime images, scripts, ADRs, lockfiles owned by upstream, lint/format configs, examples, docs.
   - **→ `[tracked]`.** Always overwritten from upstream. Conflicts are impossible by design.

If two answers feel plausible, prefer the more conservative one: `[user]` over `[merged]`, `[merged]` over `[tracked]`. Demoting a path later (e.g., `[tracked]` → `[merged]`) is a behavior change for forks and warrants a CHANGELOG note.

### Checklist when adding a new top-level path

- [ ] Add the path to `.upstream-sync.toml` under exactly one of `[tracked]`, `[merged]`, or `[user]`. Use a glob if the path is a directory or a family.
- [ ] If the path is `[user]`, update `examples/` (and `docs/extending.md` if relevant) to show users how it's intended to be customized.
- [ ] Add a sync-upstream test fixture in `scripts/__tests__/sync-upstream/` if the path's semantics are non-obvious (e.g., a glob that overlaps with another class, or a `[merged]` file with structured content like JSON).
- [ ] If you're **changing** the classification of an existing path, note it in `CHANGELOG.md` (release-please picks it up via Conventional Commit footer). Re-classification is a behavior change for downstream forks and is treated as semver-significant: demoting `[tracked]` → `[merged]` or `[merged]` → `[user]` is a minor bump; promoting in the other direction is a breaking change.
