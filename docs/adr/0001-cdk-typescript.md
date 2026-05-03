# ADR 0001: AWS CDK in TypeScript

## Status

Accepted (2026-05-03).

## Context

We need an IaC tool for the ECS+ALB+ACM+OIDC+EFS+Lambda+DynamoDB stack. Candidates: CDK (TypeScript), Terraform, AWS SAM/CloudFormation YAML, Pulumi.

## Decision

AWS CDK (TypeScript), CDK v2.

## Consequences

- Strong typing across config + IaC + glue scripts (all TypeScript).
- Best-in-class L2/L3 constructs for ECS, ALB, ACM, OIDC.
- Tied to AWS ecosystem (acceptable: this is an AWS-first project).
- `cdk synth` produces CloudFormation, which is the underlying execution engine and gives us drift detection for free.
- Trade-off: less portable than Terraform if we ever want multi-cloud (deemed unlikely).
