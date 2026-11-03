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

EFS filesystem per cluster (one), with one access point per pod. Each access point sets `Path=/pods/<podName>`, owner UID = unique per pod (allocated from `[10000, 65000)` and tracked in the pod registry). The pod's task IAM role is conditional on `elasticfilesystem:AccessPointArn = <this-ap-arn>` so even direct mount attempts fail for other pods' data. (Amended 2026-11-02: as built, task roles are shared per mode and their access-point condition matches any access point in the account, not one pod's access point. See "File-system policy" under Consequences.)

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

### File-system policy (amended 2026-11-02, issue #217)

The EFS file system carries a file-system policy (`infra/lib/stacks/cluster-stack.ts`). This is standard EFS hardening: TLS, IAM and access points required. With a policy in place, EFS no longer grants default client access, so the existing pod mount configuration (TLS, IAM authorization, one access point per pod) is the only one EFS accepts.

- **TLS required.** `ClientMount`, `ClientWrite` and `ClientRootAccess` are denied to every principal when `aws:SecureTransport` is `false`.
- **Access point required.** The same three actions are denied to every principal when the request has no `elasticfilesystem:AccessPointArn`. A mount of the file-system root, outside any access point, is refused.
- **No anonymous access.** The policy grants nothing. A client that does not authenticate with IAM is anonymous, and gets only what the policy grants it, which is nothing.
- **No root access.** Nothing grants `ClientRootAccess`. The access point's `PosixUser` decides the identity a pod writes as.
- **Identity grants on the task roles.** Each pod task role (`CloudDevPodsBrowserTaskRole`, `CloudDevPodsTunnelTaskRole`, `CloudDevPodsSshTaskRole`, in `infra/lib/stacks/pod-task-family-stack.ts`) allows `ClientMount` and `ClientWrite` on the file system, only through a mount target (`elasticfilesystem:AccessedViaMountTarget`) and an access point (`elasticfilesystem:AccessPointArn` like `arn:aws:elasticfilesystem:<region>:<account>:access-point/*`).
- **New EFS clients need their own grant.** Any new client of the file system, for example the released-workspace cleanup job that #196 may add, must mount with TLS through an access point, and its role needs its own identity grant like the one above. Without it, the mount fails.
- **Shared task roles.** The task roles are shared per mode, so the access-point condition matches any access point in the account, not one pod's access point. Per-pod separation still comes from each pod's own access point and `PosixUser`. Per-pod task roles, or conditions on access-point tags, are a separate decision.
- The policy does not affect the pod-manager Lambda, which uses only EFS control-plane actions (`CreateAccessPoint`, `DeleteAccessPoint`, `DescribeAccessPoints`, `TagResource`).
