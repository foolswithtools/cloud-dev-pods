// Phase 10: upstream sync algorithm.
//
// Reads .upstream-sync.toml to classify every path as [tracked], [merged], or [user].
// Pulls upstream/main, copies [tracked] verbatim, three-way merges [merged]
// against LAST_SYNCED_SHA -> upstream SHA -> user HEAD using `git merge-file`,
// and skips [user] entirely.
//
// On conflict: leaves diff3 markers in place; PR body lists conflicted files.
// Categorizes upgrades using package.json semver diff (patch / minor / major).
// Opens a PR via `peter-evans/create-pull-request`. Never auto-merges.
//
// State file: .upstream-sync.state.local (gitignored), updated on PR merge.

export {};
