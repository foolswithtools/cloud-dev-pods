# Teardown

Goal: zero ongoing AWS spend.

## Stop individual pods

```bash
gh workflow run pod-down.yml -f pod_name=<name>
```

EFS access point is retained by default so the pod can be re-created with state intact.

## Tear down the entire cluster

```bash
gh workflow run cluster-down.yml -f confirm=destroy
```

This destroys: ALB, target groups, ECS cluster, EFS filesystem (and any `/workspace` data, unless `efs.retainOnClusterDown` is true; see "EFS retention" below), NAT Gateway, VPC, log groups, Lambdas, DynamoDB registry.

With retention off, `cluster-down` refuses to run while pod workspaces exist on EFS, before it stops any pod. To delete them on purpose:

```bash
gh workflow run cluster-down.yml -f confirm=destroy -f delete_workspaces=true
```

It does NOT destroy:

- The `BootstrapStack` (OIDC provider, IAM roles, ECR repos) — these are cheap to keep.
- Route53 hosted zone — you brought it; you keep it.
- ACM cert — kept (free; no charge for unused certs).
- Stacks your fork adds itself, for example through `infra/extensions.local.ts`. `cluster-down` destroys only the stacks listed by `npx tsx scripts/stack-names.ts --cluster` (`<naming.prefix>-Network`, `-Cluster`, `-PodTaskFamily`, `-PodManager` and `-IdleReaper`). Any other stack is yours to tear down. If it imports outputs from one of those stacks, destroy it before running `cluster-down`, because CloudFormation won't delete a stack whose exports another stack still imports.

The stack names follow `naming.prefix` in `config/config.yaml` (default `CloudDevPods`). `cluster-down` fails before draining any pod if none of those stacks exists in CloudFormation, which usually means the prefix was changed after `cluster-up` deployed. Set it back to the deployed value and run `cluster-down` again.

## Tear down everything (including bootstrap)

If you want to fully decommission cloud-dev-pods from your AWS account:

```bash
# 1. Tear down the cluster (above).
# 2. Manually destroy BootstrapStack:
cd infra && npx cdk destroy '*Bootstrap'
# 3. Delete ECR images (CDK won't delete non-empty repos by default):
aws ecr batch-delete-image --repository-name cloud-dev-pods/vscode-browser --image-ids ...
```

## Verify

```bash
aws ecs list-clusters | grep -i cloud-dev-pods    # empty
aws elbv2 describe-load-balancers | grep -i cloud # empty
aws ec2 describe-vpcs --filters Name=tag:Project,Values=cloud-dev-pods   # empty
```

## EFS retention

By default (since v0.2.0), the EFS filesystem in `ClusterStack` is provisioned with `RemovalPolicy.DESTROY`, and `cluster-down` tears it down with the cluster. Any `/workspace` data is deleted. This is the safer default for a public dev template — orphan filesystems silently accumulating across `cluster-down` / `cluster-up` cycles is a footgun that bit users in v0.1.x (#29). See [ADR 0007](adr/0007-efs-cluster-removal-policy.md) for the rationale.

To restore the v0.1.x retain-on-`cluster-down` behavior — for instance, on a fork hosting data you cannot afford to lose — set in `config/config.yaml`:

```yaml
efs:
  retainOnClusterDown: true
```

…and re-deploy via `cluster-up.yml` BEFORE running `cluster-down`. (The flag is baked into the CloudFormation template at deploy time; toggling it without re-deploying has no effect.) `npm run init` asks this question ("Keep workspaces when the cluster is torn down?"; `--retain-workspaces` in `--non-interactive` mode) and writes the answer. A retained file system is billed at $0.30/GB-month until you delete it.

### The workspace check in `cluster-down`

Before it stops any pod, `cluster-down.yml` runs `scripts/cluster-workspace-guard.ts`. It reads the removal policy from the **deployed** Cluster stack template, because that's what `cdk destroy` applies, not `config/config.yaml`:

| Deployed policy | Pod workspaces on EFS | `delete_workspaces` | Result |
| --- | --- | --- | --- |
| RETAIN | any | any | Proceeds. The file system is kept. |
| DESTROY | none | any | Proceeds. The file system is deleted. |
| DESTROY | some | `true` | Proceeds. The file system and workspaces are deleted. |
| DESTROY | some | `false` (default) | Refuses, and names the workspaces. Nothing is stopped or deleted. |

If config says `retainOnClusterDown: true` but `cluster-up` hasn't run since you changed it, the deployed policy is still DESTROY and the check says so. The job summary reports what happened to EFS: retained (with the file-system ID) or deleted.

**Detection limit.** The check counts the file system's EFS access points. Each pod gets one at `pod-up`, and `pod-down` keeps it by default (`keep_workspace=true`), so kept workspaces are found. `pod-down -f keep_workspace=false` deletes the access point but leaves the files on EFS. Seeing those directories needs a mount, so the check can't, and `cluster-down` deletes them without asking.

### Backing up workspaces before `cluster-down`

There's no built-in backup (ADR 0007 lists snapshot-on-down as a future option). Before a `cluster-down` with `delete_workspaces=true`:

- Push your work. `pod-up` each pod (same name, so it reattaches its workspace), commit and push from inside it, then `pod-down`.
- Or copy files out: download them from the browser pod's VS Code explorer, or copy them over the tunnel from VS Code Desktop.
- Or keep the whole file system instead: turn retention on and run `cluster-up` first, as above.

### Cleaning up orphan EFS / access points from prior versions

If you upgraded from v0.1.x and now have leftover EFS filesystems or duplicate per-pod access points cluttering the account, the maintainer script handles both:

```bash
# Dry-run, scans both filesystems and access points:
scripts/maintainer/cleanup-orphan-efs.sh --mode all

# Apply:
scripts/maintainer/cleanup-orphan-efs.sh --mode all --apply
```

The script will not delete an EFS filesystem while `CloudDevPods-Cluster` exists, and will not delete an access point whose pod-name is in the live registry. Safe to run any time.
