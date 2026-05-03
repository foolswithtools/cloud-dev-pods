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
