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

## Consequences

- Per-pod data isolation enforced by both POSIX permissions and IAM.
- EFS access points are created at first `pod-up` and retained by default on `pod-down` (state preserved across pod restarts).
- EFS supports up to 1000 access points per filesystem — fine for individual users, watchpoint for teams.
- EFS performance for IDE I/O is acceptable for source code but not for `node_modules` install. Documented in `docs/operating.md`.
