# Cost controls

Cloud-dev-pods provisions real AWS resources in your account. Most of the bill is fixed (NAT + ALB) and accrues whether or not pods are running. Set a budget alarm before your first `cluster-up`. The two-minute setup below catches the common footgun: stand up a cluster for a smoke test, get distracted, find out three weeks later that you've been paying ~$50/mo for an idle stack.

## Idle cost (cluster up, zero pods running)

| Resource | Why it costs | Approx monthly |
| --- | --- | --- |
| NAT Gateway × 1 | Hourly charge + per-GB data processing on egress | ~$32 |
| Application Load Balancer | LCU-hours (load-balancer capacity units) for an idle ALB | ~$16 |
| EFS storage | $0.30/GB-month, Bursting throughput | ~$0 (negligible until workspaces grow) |
| Secrets Manager × 3 | $0.40/secret/month for the three OAuth secrets | ~$1.20 |
| Other (CloudWatch Logs, Route53 zone, SSM Parameter Store, DynamoDB on-demand registry) | All effectively free at this scale | ~$0 |
| **Idle total** | | **~$50/mo** |

`cluster-down` removes everything except the bootstrap stack (OIDC + IAM + ECR + the three Secrets Manager secrets). Post-teardown ongoing spend drops to ~$0.40/month (the three secrets) plus any data sitting in EFS, which is also gone since EFS is part of `cluster-down`.

## Per-pod runtime cost

Browser or tunnel mode, 1 vCPU / 2 GB on Fargate Spot:

- ~$0.014/hour at the default sizing.
- A pod left running 24×7 costs ~$10/month. The idle reaper (default 60-minute threshold) keeps this from happening for browser pods you forget about — it doesn't reap tunnel pods.

For the Spot rate variation across regions and the on-demand fallback rate (~3× higher when Spot capacity is reclaimed), see the [Fargate pricing page](https://aws.amazon.com/fargate/pricing/).

## Run-vs-down decision

| Time the cluster will sit idle | Recommendation |
| --- | --- |
| < 4 hours | Leave up. Re-running `cluster-up` takes ~12 min. |
| 4 hours – 1 day | Judgement call. ~$1–2 to leave up vs. ~12 min restart cost. |
| > 1 day | `cluster-down`. Bootstrap state is retained, so the next `cluster-up` is fast. |

```bash
gh workflow run cluster-down.yml -f confirm=destroy
gh run watch
```

If pods are still running, the workflow will refuse unless you also pass `force=true`. Don't pass `force=true` without first running `pod-list.yml` and confirming what you'd be killing.

## Set up an AWS Budgets alarm (recommended)

Two alarms on a $75/mo budget — at 80% (warn) and 100% (act).

### 1. Subscribe an email to the SNS topic

```bash
aws sns create-topic --name cloud-dev-pods-budget-alarms
TOPIC_ARN=$(aws sns list-topics --query "Topics[?contains(TopicArn, 'cloud-dev-pods-budget-alarms')].TopicArn | [0]" --output text)

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint you@example.com
# Check your inbox and click the SNS confirmation link.
```

### 2. Create the budget

Save this as `budget.json`, replace `<account-id>`:

```json
{
  "BudgetName": "cloud-dev-pods-monthly",
  "BudgetLimit": { "Amount": "75", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "TagKeyValue": ["user:Project$cloud-dev-pods"]
  }
}
```

> The `CostFilters` block scopes the budget to resources tagged `Project=cloud-dev-pods` (every stack created by this project tags its resources). Drop the `CostFilters` block if you want an account-wide budget instead — useful if you have other workloads in the same account and want to catch total spend, not just cloud-dev-pods spend. Cost-allocation tags must be **activated** in the Billing console (Billing → Cost allocation tags → activate `Project`) before they show up as a filter dimension; this can take up to 24 hours to start populating data.

Notifications config (`notifications.json`):

```json
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [
      { "SubscriptionType": "SNS", "Address": "arn:aws:sns:<region>:<account-id>:cloud-dev-pods-budget-alarms" }
    ]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "PERCENTAGE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [
      { "SubscriptionType": "SNS", "Address": "arn:aws:sns:<region>:<account-id>:cloud-dev-pods-budget-alarms" }
    ]
  }
]
```

Create (run as your own AWS admin identity, **not** via the GitHub OIDC roles — those are denied `budgets:*` by `CloudDevPodsBoundary` on purpose; see [`aws-permissions.md`](aws-permissions.md)):

```bash
aws budgets create-budget \
  --account-id <account-id> \
  --budget file://budget.json \
  --notifications-with-subscribers file://notifications.json
```

Verify:

```bash
aws budgets describe-budget \
  --account-id <account-id> \
  --budget-name cloud-dev-pods-monthly
```

### 3. Tune the threshold

$75/mo is a safety net, not a target. Idle = ~$50, so you'd hit the 80% notification ($60) only if pods have been running. Tune higher if you expect heavy pod use; tune lower if you only ever smoke-test.

## Idle reaper (browser pods only)

Configured per-cluster via `pods.idleMinutes` in `config/config.yaml` (default 60). Per-pod override:

```bash
gh workflow run pod-up.yml -f pod_name=long-job -f mode=browser -f idle_minutes=0   # disable
gh workflow run pod-up.yml -f pod_name=quick    -f mode=browser -f idle_minutes=15  # tighter
```

Subscribe to the SNS topic that fires before the reaper actually stops a pod — gives you a chance to keep it alive:

```bash
aws sns subscribe \
  --topic-arn $(aws ssm get-parameter --name /cloud-dev-pods/dev/idle-reaper/topic-arn --query Parameter.Value --output text) \
  --protocol email --notification-endpoint you@example.com
```

Tunnel pods are not idle-reaped (no useful idle signal from `code tunnel`). Stop them with `pod-down.yml` when you're done.

## Reminder cadence

Patterns that catch the common forget-to-tear-down footgun:

- Run `gh workflow run pod-list.yml` at the end of each working day. It's free, and the output reminds you what's running.
- Calendar a recurring "cluster check" Friday afternoon: `gh run list --workflow cluster-up.yml --limit 1` shows when you last brought it up.
- Wire `cluster-down` into your end-of-day shutdown if you're not running pods overnight. The 12-minute `cluster-up` next morning is cheap insurance.

## What gets retained after `cluster-down`

Intentional retentions (by `RemovalPolicy.RETAIN` in the CDK stacks):

- **Bootstrap stack** (OIDC provider, IAM roles, ECR repos, the three OAuth secrets). Retained so the next `cluster-up` doesn't have to redo these — they're slow or annoying to recreate.
- **ECR images** (no automatic delete on `cluster-down`).

Everything else — VPC, NAT, ALB, EFS, ECS cluster, Lambdas, CloudWatch log groups (after Phase 15.5 fix), DynamoDB registry — is destroyed.

If you want true zero-AWS-spend (no Secrets Manager $0.40 × 3 either), tear down the bootstrap stack manually:

```bash
aws cloudformation delete-stack --stack-name cloud-dev-pods-bootstrap-dev
aws cloudformation wait stack-delete-complete --stack-name cloud-dev-pods-bootstrap-dev
```

You'll redo `bootstrap-aws.yml` the next time you want to use the platform — adds ~3 min but gets you to literal $0.

## See also

- [`operating.md`](operating.md) — pod-level cost discussion.
- [`teardown.md`](teardown.md) — full teardown procedure.
- [`troubleshooting.md`](troubleshooting.md) — orphaned-resource cleanup if `cluster-down` left something behind.
