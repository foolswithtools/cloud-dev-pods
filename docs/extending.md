# Extending cloud-dev-pods

The repo is a template, but `infra/lib/**` is `[tracked]` in `.upstream-sync.toml` — meaning every `sync-upstream` run overwrites it. So how do you customize?

## The extension-point pattern

Every CDK stack reads optional hooks from `infra/extensions.local.ts` (in the `[user]` taxonomy — never overwritten). Hooks let you inject your own VPC CIDR, extra subnets, extra tags, custom security group rules, custom container env vars, etc., without modifying upstream code.

## Example: customize VPC CIDR

```ts
// infra/extensions.local.ts
import type { ClusterStack, NetworkStack } from './lib/stacks/index.js';

export const extensions = {
  customizeNetwork(stack: NetworkStack): void {
    // your changes here — e.g., set CIDR, add subnets, add VPC endpoints
  },
  customizeCluster(stack: ClusterStack): void {
    // your changes here — e.g., add capacity providers, tweak ALB
  },
};
```

The CDK app (`infra/bin/app.ts`) loads `extensions.local.ts` if it exists and calls each hook after constructing the corresponding stack.

## When extensions aren't enough

If you need to fundamentally change `infra/lib/**`, you can:

1. Move the relevant file from `[tracked]` to `[merged]` in your local `.upstream-sync.toml` (also `[user]`-classified, so this customization sticks). You'll get three-way merge conflicts on upstream changes, which is the price.
2. Open an issue / PR upstream proposing a new extension point.

### Extensions that add an EFS client

The workspace file system has a file-system policy (ADR 0004, [File-system policy](adr/0004-efs-per-pod-access-point.md#file-system-policy-amended-2026-11-02-issue-217)). Anything your extensions add that mounts it, such as a backup or sync job, must mount with TLS through an access point, and its role needs its own `elasticfilesystem:ClientMount` grant (plus `ClientWrite` if it writes). Root access isn't available. Otherwise the mount is refused; see [troubleshooting](troubleshooting.md#ecs-task-fails-with-resourceinitializationerror--efs--access-denied).

## What to NEVER customize

- `.github/workflows/ci-*.yml` — these guarantee your fork's quality.
- `runtime/**` — overwriting these defeats the security/scanning posture.

If you really need a custom runtime image, push it to your own ECR repo and point `--image_tag` at it.

## How `sync-upstream.yml` works

The `sync-upstream.yml` workflow runs weekly (and on demand). For each path that differs between the last-synced upstream SHA and current upstream:

- `[tracked]` — overwrite from upstream (`git checkout upstream/main -- <path>`).
- `[merged]` — three-way merge against your HEAD using `git merge-file --diff3`. If conflict markers are produced, the PR body lists the file under "Conflicted files (resolve before merging)".
- `[user]` — left untouched.
- Files deleted upstream that you haven't modified are removed; files you've modified are kept with a note.

State is tracked in `.upstream-sync.state` (committed). Each successful sync updates it to the new upstream SHA so the next run starts from there.

## Bootstrapping config

Your fork's `config/config.yaml` is `[user]` — sync never touches it. You set its values once via `npm run init` (Phase 12, coming soon) or by hand. When upstream adds new config keys, the new fields fall back to schema defaults until you set them; `cdk synth` will warn loudly if a required key is missing.
