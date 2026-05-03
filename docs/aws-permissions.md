# AWS permissions

The IAM model has three roles:

## 1. One-time bootstrap user (your own admin)

Used only for a single `bootstrap-aws.yml` run. Creates the OIDC provider and the two long-lived roles below. After bootstrap completes, you can rotate or delete this credential.

## 2. `CloudDevPodsDeployerRole`

Assumed by GitHub Actions OIDC for `cluster-up.yml`, `cluster-down.yml`, and `bootstrap-aws.yml` (after first run).

Trust policy condition (`sub` claim) restricts to:

```text
repo:<owner>/<repo>:ref:refs/heads/main
repo:<owner>/<repo>:environment:prod
```

Permissions: broad CloudFormation, IAM PassRole, EC2 (VPC), ECS, ELBv2, ACM, Route53, Logs, Lambda, Events, EFS — bounded by `CloudDevPodsBoundary` (denies actions on resources not tagged `Project=cloud-dev-pods`).

## 3. `CloudDevPodsPodOpsRole`

Assumed by `pod-up.yml`, `pod-down.yml`, `pod-list.yml`, `build-runtime.yml`.

Permissions:

- `lambda:InvokeFunction` on `pod-manager` only.
- `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:Put*` on the project's ECR repos.
- `logs:FilterLogEvents` on the pods log group.

The pod-manager Lambda's execution role holds the actual ECS/ALB/EFS write permissions — those are NOT in the GitHub OIDC role. A compromised GitHub Actions run can only invoke `pod-manager` with declared inputs (validated server-side), not arbitrary AWS APIs.

(Phase 4 will paste the actual policy JSON here.)
