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

This destroys: ALB, target groups, ECS cluster, EFS filesystem (and any `/workspace` data — see "EFS retention" below to opt out), NAT Gateway, VPC, log groups, Lambdas, DynamoDB registry.

It does NOT destroy:

- The `BootstrapStack` (OIDC provider, IAM roles, ECR repos) — these are cheap to keep.
- Route53 hosted zone — you brought it; you keep it.
- ACM cert — kept (free; no charge for unused certs).

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

…and re-deploy via `cluster-up.yml` BEFORE running `cluster-down`. (The flag is baked into the CloudFormation template at deploy time; toggling it without re-deploying has no effect.)

### Cleaning up orphan EFS / access points from prior versions

If you upgraded from v0.1.x and now have leftover EFS filesystems or duplicate per-pod access points cluttering the account, the maintainer script handles both:

```bash
# Dry-run, scans both filesystems and access points:
scripts/maintainer/cleanup-orphan-efs.sh --mode all

# Apply:
scripts/maintainer/cleanup-orphan-efs.sh --mode all --apply
```

The script will not delete an EFS filesystem while `CloudDevPods-Cluster` exists, and will not delete an access point whose pod-name is in the live registry. Safe to run any time.
