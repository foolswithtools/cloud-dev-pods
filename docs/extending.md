# Extending cloud-dev-pods

The repo is a template, but `infra/lib/**` is `[tracked]` in `.upstream-sync.toml` — meaning every `sync-upstream` run overwrites it. So how do you customize?

## The extension-point pattern

Customize the stacks from `infra/extensions.local.ts`. It's `[user]` in `.upstream-sync.toml`, so `sync-upstream` never overwrites it. `npm run init` writes a stub. Each hook is optional, gets its stack plus `{ app, config }`, and runs right after that stack is constructed, so a later hook sees what an earlier one added:

| Hook | Stack |
| --- | --- |
| `customizeBootstrap` | `<prefix>-Bootstrap` |
| `customizeNetwork` | `<prefix>-Network` |
| `customizeCluster` | `<prefix>-Cluster` |
| `customizePodTaskFamily` | `<prefix>-PodTaskFamily` |
| `customizePodManager` | `<prefix>-PodManager` |
| `customizeIdleReaper` | `<prefix>-IdleReaper` |

The CDK app (`infra/bin/app.ts`) loads the file when it exists. An unknown hook name (for example `customiseNetwork`), a hook that isn't a function, or a missing `extensions` export fails `cdk synth` with a message naming the file. cdk-nag checks the resources your hooks add like any others, so a finding fails synth until you fix it or acknowledge it.

## Example: tag the VPC and add a VPC endpoint

```ts
// infra/extensions.local.ts
import { Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Extensions } from './lib/extensions';

export const extensions: Extensions = {
  customizeNetwork(stack) {
    Tags.of(stack.vpc).add('CostCenter', 'platform');
    stack.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
  },
  customizeCluster(stack, { config }) {
    // e.g. tweak the ALB or add alarms; `config` is the parsed config/config.yaml.
  },
};
```

## Commit it

`cluster-up` synthesizes from a fresh checkout, so an uncommitted `extensions.local.ts` has no effect on what it deploys. Commit and push it like `config/config.yaml`:

```bash
git add infra/extensions.local.ts && git commit -m 'chore: fork extensions' && git push
```

It's code, not configuration: keep secrets out of it (read them at deploy or run time from Secrets Manager or SSM). It's excluded from the `*.local.*` ignore rule for this reason.

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
