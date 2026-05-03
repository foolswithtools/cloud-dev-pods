# ADR 0005: Host-based ALB routing per pod

## Status

Accepted (2026-05-03).

## Context

For browser-mode pods, the ALB needs to route `https://<pod>.<base-domain>` to the right ECS task. Two options:

- Path-based: `https://<base-domain>/<pod>/`. One ALB rule per pod, but VS Code's webview, language server, and extension URLs assume root-path serving. Rewriting under a path prefix breaks frequently.
- Host-based: `https://<pod>.<base-domain>`. One ALB rule per pod. Cookies for oauth2-proxy are scoped per host, isolating sessions cleanly.

## Decision

Host-based routing.

ACM cert is wildcard `*.<base-domain>`. Route53 wildcard A-alias `*.<base-domain> → ALB`. Each pod gets a listener rule matching `Host == <pod>.<base-domain>` → forward to per-pod target group.

Rule priority: `(fnv1a(podName) % 49000) + 1000` with collision retry up to 5 attempts.

## Consequences

- One DNS record handles all pods (wildcard alias) — no per-pod DNS work.
- VS Code's path-prefix assumptions are honored.
- Constraint: ALB has a default of 100 rules per listener. Documented; quota raise to 1000 is straightforward.
- Cookies are session-isolated per pod automatically.
