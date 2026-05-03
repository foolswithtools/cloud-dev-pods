# Operating cloud-dev-pods

Day-2 operations for downstream users.

## Common commands

```bash
gh workflow run pod-up.yml -f pod_name=foo -f mode=browser
gh workflow run pod-down.yml -f pod_name=foo
gh workflow run pod-list.yml
gh workflow run cluster-down.yml -f confirm=destroy   # zero ongoing cost
```

## Costs

The biggest fixed costs are:

- ALB (~$16/mo)
- NAT Gateway (~$32/mo)
- EFS storage ($0.30/GB-month)

Pods themselves cost ~$0.014/hour on Fargate Spot (1 vCPU / 2 GB) while running. Idle reaper auto-stops pods after `idleMinutes`.

To go to zero ongoing cost: `cluster-down`.

## EFS performance for IDE I/O

EFS in Bursting mode is fine for source code but slow for `node_modules` install or large repo `git clone`. Recommended:

- Keep `node_modules` on the container's writable layer (ephemeral).
- Use `pnpm` with a content-addressed store on EFS for shared deps.
- For power users, enable Provisioned Throughput (extra cost).

## Custom images

Phase 5+ will document how to publish your own runtime image and reference it via `--image_tag` on `pod-up.yml`.

## Logs

```bash
aws logs tail /cloud-dev-pods/pods --follow --since 10m
```

## Limits

- **ALB listener rules: default 100 per listener.** With one rule per browser pod (host-based routing), this is the practical pod ceiling per cluster. Browser pods that fail with `PriorityInUse` after ~95 active pods are likely hitting it. Raise via Service Quotas (request `L-EAD7E5BC` → 1000) or shard pods across additional ALBs.
- **EFS access points: 1000 per filesystem.** One per pod; the lifecycle is "create on first up, retain across down (default), delete on `pod-down --no-keep-workspace`". Watch out for accumulation if many pods are created/destroyed without `keepWorkspace=false`.
- **POSIX UIDs: 10000–65000.** ~55k unique pods over the lifetime of a cluster. UIDs aren't recycled while the pod is in the registry; once `pod-down` removes the entry, the UID is free.
- **Fargate task quotas: 1000 tasks per region per account.** Default. Rarely a concern.

## Idle reaper behavior

The idle reaper runs every 5 minutes (per cluster). For each browser pod:

1. Reads `RequestCount` on the pod's ALB target group over the last `idleMinutes` (default 60). If sum is 0, marks the pod with `idleSince=<timestamp>` in DynamoDB and publishes a notification to the SNS topic `cloud-dev-pods-idle-warnings`.
2. On the next reaper cycle, if the pod is still idle, invokes `pod-manager.down(podName, keepWorkspace: true)` — task stops, ALB rule + target group are removed, EFS workspace is retained.

To opt out per-pod, run `pod-up` with `--idle 0`. To subscribe to idle warnings:

```bash
aws sns subscribe \
  --topic-arn $(aws ssm get-parameter --name /cloud-dev-pods/dev/idle-reaper/topic-arn --query Parameter.Value --output text) \
  --protocol email --notification-endpoint you@example.com
```

Tunnel-mode pods are NOT idle-reaped in v1 (no useful idle signal from the `code tunnel` agent). Stop them manually with `pod-down`.

The reaper also handles **task-stopped cleanup**: if an ECS task transitions to STOPPED for any reason (crash, manual `aws ecs stop-task`, capacity reclaim), the reaper invokes `pod-manager.down` to remove the orphaned ALB rule + target group + DDB entry.
