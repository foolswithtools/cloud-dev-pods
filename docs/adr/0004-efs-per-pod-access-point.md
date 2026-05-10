# ADR 0004: EFS per-pod access point with POSIX UID isolation

## Status

Accepted (2026-05-03).

## Context

Pods need persistent workspace storage that survives task restarts. Options for Fargate:

- Ephemeral container storage. Lost on restart. Unacceptable.
- EBS volumes. Fargate doesn't support attaching pre-existing EBS volumes.
- EFS shared filesystem. Supported; access points provide POSIX UID isolation.
- S3 sync. Lossy round-trips, breaks `git`, awkward for IDE I/O.

## Decision

EFS filesystem per cluster (one), with one access point per pod. Each access point sets `Path=/pods/<podName>`, owner UID = unique per pod (allocated from `[10000, 65000)` and tracked in the pod registry). The pod's task IAM role is conditional on `elasticfilesystem:AccessPointArn = <this-ap-arn>` so even direct mount attempts fail for other pods' data.

### Reuse semantics (amended 2026-05-09 — fixes #30)

- On every `pod-up`, the pod-manager Lambda calls `findExistingAccessPoint(podName)` after the registry-conflict check and before allocating a fresh UID. The lookup queries `DescribeAccessPoints` filtered by the cluster's `FileSystemId`, then in-memory-filters by `Tags[].Key === 'Pod' && .Value === podName`, and returns the newest `available` access point.
- If a hit is returned, `pod-up` reuses both `accessPointId` and `PosixUser.Uid` — `allocatePosixUid()` and `createAccessPoint()` are skipped.
- **Canonical-UID rule:** the `PosixUser.Uid` on the EFS access point itself is the source-of-truth for a pod's UID. The `posixUid` field on the DDB registry record is a cache while the pod is registered; it MUST be re-read from the AP on every `pod-up` rather than re-allocated.
- **Duplicate-AP self-heal:** if multiple APs match the same `Pod` tag (an artifact of pre-v0.2.0 deployments that created a fresh AP every `pod-up`), the lookup keeps the newest and fires `DeleteAccessPoint` on the rest, fire-and-forget. Deletion failures are logged, never thrown — a stuck duplicate must not block `pod-up`.
- **Rollback safety:** the `pod-up` rollback handler tracks a local `createdNewAp: boolean` and only deletes the access point when `true`. Reusing a persistent AP and then deleting it on rollback would erase user `/workspace` data — which is what made #29 hurt. See ADR 0007.

## Consequences

- Per-pod data isolation enforced by both POSIX permissions and IAM.
- EFS access points are created at first `pod-up` and retained by default on `pod-down` (state preserved across pod restarts).
- EFS supports up to 1000 access points per filesystem — fine for individual users, watchpoint for teams.
- EFS performance for IDE I/O is acceptable for source code but not for `node_modules` install. Documented in `docs/operating.md`.
