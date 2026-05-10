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

## Source of truth

Both roles and the boundary are CDK-defined in [`infra/lib/stacks/bootstrap-stack.ts`](../infra/lib/stacks/bootstrap-stack.ts) — that's the canonical reference. The summary below describes what's there as of `main`; if it drifts from the source, the source wins.

### `CloudDevPodsDeployerRole` policies

- AWS managed `PowerUserAccess` (covers most CDK deploy needs across CloudFormation, EC2/VPC, ECS, ELBv2, ACM, Route53, CloudWatch Logs, Lambda, EventBridge, EFS, Secrets Manager, SSM Parameter Store, ECR, DynamoDB, SNS).
- Inline `iam:*` on `*` (CDK creates and updates task roles, Lambda execution roles, etc.; `PowerUserAccess` excludes IAM by design).
- Permissions boundary: `CloudDevPodsBoundary` (next section).

### `CloudDevPodsPodOpsRole` inline policies

Three statements, scoped to project resources:

1. `lambda:InvokeFunction` on `arn:aws:lambda:<region>:<account>:function:pod-manager`.
2. `ecr:GetAuthorizationToken` on `*` (AWS contract — this action does not accept a resource ARN), plus `ecr:BatchCheckLayerAvailability`, `ecr:CompleteLayerUpload`, `ecr:InitiateLayerUpload`, `ecr:PutImage`, `ecr:UploadLayerPart`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` on `arn:aws:ecr:<region>:<account>:repository/cloud-dev-pods/*`.
3. `logs:FilterLogEvents`, `logs:GetLogEvents` on `arn:aws:logs:<region>:<account>:log-group:/cloud-dev-pods/*`.

Notably absent: ECS, ELBv2, EFS, IAM. Those operations go through the `pod-manager` Lambda's execution role, not through this GitHub OIDC role.

### `CloudDevPodsBoundary` (permissions boundary, both roles)

Effect-allow on `*:*`, then explicit denies that contain blast radius:

- Deny `iam:CreateUser`, `iam:CreateAccessKey`, `iam:DeleteUser`, `organizations:*`, `account:*`, `aws-portal:*`, `budgets:*` on `*`. (A compromised role can't create new IAM users, manipulate the AWS Organization, change account-level settings, or tamper with billing.)
- Deny `iam:CreateRole`, `iam:DeleteRole`, `iam:UpdateRole`, `iam:AttachRolePolicy`, `iam:DetachRolePolicy`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy` on every resource **except** `arn:aws:iam::<account>:role/cloud-dev-pods/*`. (Role manipulation is locked to the project's IAM path.)

The boundary applies even if a future PR loosens the role's own policies.
