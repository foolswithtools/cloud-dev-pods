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
