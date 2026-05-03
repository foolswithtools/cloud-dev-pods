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

This destroys: ALB, target groups, ECS cluster, EFS filesystem, NAT Gateway, VPC, log groups, Lambdas, DynamoDB registry.

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
