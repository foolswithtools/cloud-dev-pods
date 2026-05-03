# ADR 0003: Pod-manager Lambda owns ECS/ALB/EFS write rights

## Status

Accepted (2026-05-03).

## Context

GitHub Actions workflows need to spin pods up and down. Options:

- (a) Direct AWS CLI (`aws ecs run-task`, `aws elbv2 create-rule`, ...) in workflow YAML. Straightforward but no transactional guarantees, race conditions across concurrent runs, ALB rule cleanup on failure is hard.
- (b) Pod-manager Lambda invoked by the workflow. Single transactional unit, observable, testable, retryable.
- (c) Step Functions state machine. Most resilient but most complex.

## Decision

Option (b): a single Node 20 ARM64 Lambda named `pod-manager` with actions `up | down | list | status`. DynamoDB registry for pod state with conditional writes. No Step Functions for v1.

## Consequences

- The GitHub Actions OIDC role (`PodOpsRole`) only has `lambda:InvokeFunction` on this Lambda. ECS/ALB/EFS write rights live on the Lambda's execution role, not on a workflow-assumed role.
- A compromised workflow run can only invoke `pod-manager` with declared inputs (server-side validated), not arbitrary AWS APIs. Dramatically narrower blast radius than option (a).
- Single point of failure: if `pod-manager` is unhealthy, no pod ops work. Mitigation: keep it small, version it, alarm on errors.
- Lambda cold start is ~1-2s; negligible vs total pod-up time (~3 min).
