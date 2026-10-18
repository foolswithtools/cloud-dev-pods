# Spec: pluggable identity providers and remote access

Status: accepted for issue authoring (2026-10-18). Owner: maintainer.

This spec records the research and decisions behind the "pluggable identity providers & remote access" epic. Each work item below has a stable ID (`F1`, `A2`, `C1`, …) that its GitHub issue references via `spec: docs/specs/pluggable-identity-remote-access.md#<id>`.

## Goal

Let users of the template choose, per deployment:

1. **Which identity provider (IdP)** authenticates browser-mode pods: GitHub (today), Microsoft Entra ID, WorkOS, or any standards-compliant OIDC provider.
2. **Whether to use Microsoft dev tunnels**, and with which account type (GitHub or Microsoft/Entra).
3. **An alternative to Microsoft dev tunnels** for VS Code Desktop access, using Remote-SSH over an identity-aware transport (AWS Session Manager, Cloudflare, Tailscale).

Non-goal: multiple IdPs active at the same time (see deferred item A8).

Every feature keeps today's behavior as the default (`provider: github`, `mode: browser|tunnel` as now), so existing forks pick up the code through `sync-upstream` without config changes.

## Current state (as of v0.4.0)

- **Browser pods** are an ECS task with two containers: openvscode-server on `127.0.0.1:3000` with `--without-connection-token` (`runtime/vscode-browser/entrypoint.sh`) and an `oauth2-proxy:v7.7.1` sidecar on `:4180`, the only port the ALB can reach (`infra/lib/stacks/network-stack.ts:87`). The ALB does host-header routing only; it performs no authentication (`infra/lambda/pod-manager/aws.ts:462`).
- **GitHub coupling** is confined to:
  - sidecar env `OAUTH2_PROXY_PROVIDER=github` + `GITHUB_ORG`/`GITHUB_USER`, built at runtime by the pod-manager Lambda (`infra/lambda/pod-manager/aws.ts:286`) and duplicated in the CDK task family (`infra/lib/stacks/pod-task-family-stack.ts:181`);
  - config keys `github.oauthAllowedOrg/Users` (`infra/lib/config/schema.ts:17`), passed through `infra/lib/stacks/pod-manager-stack.ts:94` and `infra/lambda/pod-manager/env.ts:33`;
  - the fail-fast guard at `infra/lambda/pod-manager/actions.ts:42`.
  - The Secrets Manager paths `/cloud-dev-pods/oauth/{client-id,client-secret,cookie-secret}` are provider-agnostic.
- **Authorization gap:** every sidecar receives the same global allowlist, cookie secret, and client ID. `owner` is only a tag derived from `GITHUB_ACTOR` (`scripts/pod-cli.ts:65`). Any allowlisted user can open any pod.
- **Callback constraint:** oauth2-proxy derives the callback from the request host, so every pod has a distinct `https://<pod>.<base>/oauth2/callback`. GitHub OAuth Apps accept one callback URL, which is why browser mode pins a pod name at setup time (CLAUDE.md rule 6, step 3d).
- **Tunnel pods** run `code tunnel` (`runtime/vscode-tunnel/entrypoint.sh:6`). The log poller already recognizes both GitHub and Microsoft device-code URLs (`scripts/tunnel-poll-logs.ts:51`).
- **Fork extensibility:** `infra/lambda/**` is not classified in `.upstream-sync.toml`, so `sync-upstream` treats it as `[tracked]`. The `extensions.local.ts` hooks only reach CDK stacks, not the Lambda that builds task definitions. All of this work must land upstream.

## Research findings

### Identity providers (browser mode)

| | Protocol path in oauth2-proxy | Wildcard callback URLs | Notes |
|---|---|---|---|
| GitHub | `provider=github` | No (one callback per OAuth App) | Current default. |
| Entra ID | `provider=entra-id` (oauth2-proxy ≥ v7.8.0) or `provider=oidc` with issuer `https://login.microsoftonline.com/<tenant>/v2.0` (works on v7.7.1) | No; max 256 redirect URIs per app registration | Native provider adds `--entra-id-allowed-tenant` and Graph-based group overage (> 200 groups needs `User.Read`). Authorization via `allowed_groups` (group object IDs) or app "assignment required". |
| WorkOS | `provider=oidc` against a WorkOS Connect application; discovery at `https://<authkit-domain>/.well-known/openid-configuration`, issuer `https://<authkit-domain>`, RS256 | Documented for AuthKit/SSO redirect URIs (one wildcard, leftmost label, not a public suffix); **unconfirmed for Connect apps** | **Unconfirmed:** whether the ID token carries `email`/`email_verified`. Documented claims are `sub` and `org_id`. |
| Generic OIDC (Okta, Auth0, Google, Keycloak) | `provider=oidc` | Okta and Auth0 support wildcard subdomains | Falls out of the WorkOS code path. |

oauth2-proxy has no inline "allowed emails" flag; per-user allowlists use `--authenticated-emails-file`. The official image is distroless (no shell), so the file must be written by another container into a shared ephemeral volume.

ALB native `authenticate-oidc` works with any OIDC IdP but requires an HTTPS listener, still needs one `/oauth2/idpresponse` callback per host, and only authenticates (no claim-based authorization). Cognito (`authenticate-cognito`) can broker multiple IdPs but also has no wildcard callbacks.

### Microsoft dev tunnels

- Only GitHub and Microsoft (including Entra work/school) accounts can host or connect; both ends must use the same account. `code tunnel user login --provider github|microsoft` selects the account type (flag observed in third-party mirrors of the CLI docs; verify against the pinned CLI).
- **All traffic is relayed** through Microsoft's dev tunnels service (`*.rel.tunnels.api.visualstudio.com`); there is no documented direct/peer-to-peer path. VS Code runs SSH over the tunnel for end-to-end encryption (AES-256-CTR). Port-forwarding web URLs (`*.devtunnels.ms`) terminate TLS at Microsoft and are visible to the service.
- **Free, with no paid tier and no SLA.** Monthly per-user limits: 5 GB bandwidth, 10 tunnels, 10 ports per tunnel, 1000 connections per port, 1500 HTTP req/min per port, 20 MB/s per tunnel. Registering an 11th tunnel makes the CLI delete a random unused one. Unused tunnels expire after 30 days.
- The relay service is not self-hostable; the open-source `microsoft/dev-tunnels` repo provides SDKs only.

### Alternatives (Remote-SSH)

VS Code Remote-SSH gives the same Desktop experience as tunnels and is transport-agnostic, so identity moves to the transport:

| Backend | Traffic path | IdPs | Cost |
|---|---|---|---|
| AWS Session Manager (ECS Exec port forwarding) | AWS SSM service | Whatever IAM Identity Center federates (Entra, Okta, Google via SAML); WorkOS is not a natural fit | Free (uses existing NAT) |
| Cloudflare Tunnel + Access | Cloudflare edge | Nearly any, including generic OIDC (WorkOS) | Free up to 50 users |
| Tailscale | Direct WireGuard, DERP relay fallback (encrypted) | Entra, Google, GitHub, Okta, custom OIDC | Free personal; per-user team plans |
| opkssh | Identity layer only; pair with a transport | Google, Microsoft, GitLab, generic OIDC | Free |
| Teleport / Pomerium / Boundary | Self-hosted proxy | Any OIDC/SAML | Hosting cost of an always-on service |

## Decisions

- **D1.** Introduce a provider-neutral `auth:` config block; keep `github.*` keys working as deprecated aliases.
- **D2.** For the single-callback problem, build the **central auth host (A5)**; do not build Graph API redirect-URI automation (A6, deferred).
- **D3.** Per-pod owner authorization (F4) is **opt-in** (`auth.browser.ownerOnly: false` by default) to avoid a breaking change.
- **D4.** Run the WorkOS spike (A3-spike) and the ECS Exec spike (C1-spike) during Wave 1, because they gate later waves and have no dependencies.
- **D5.** Track waves with GitHub milestones under a single epic; deferred items live in one parking-lot issue.
- **D6.** Build the AWS-native SSH backend (C1) before third-party backends.

## Work items

Waves map to milestones `Wave 1` … `Wave 4` and `Later`.

### Wave 1: foundations

<a id="f1"></a>

#### F1. Provider-neutral `auth:` config + ADR 0008

Add `auth.browser.{provider, issuerUrl, allowedEmailDomains, allowedGroups, allowedUsers, allowedOrg, ownerOnly}` (provider default `github`) and `auth.tunnel.provider` (default `github`). Map `github.oauthAllowedOrg/Users` into `auth.browser.allowedOrg/allowedUsers` with a synth-time deprecation warning. Plumb through the pod-manager stack env and Lambda env. ADR 0008 amends ADR 0002. Only the `github` provider is wired at runtime in this item.

<a id="f2"></a>

#### F2. Provider-neutral fail-fast guard

Replace the GitHub-specific guard at `actions.ts:42` with a function that refuses browser `pod-up` unless the active provider has at least one restriction (org, users, groups, email domains, or tenant). `EMAIL_DOMAINS=*` with nothing else must be refused for every provider.

<a id="f3"></a>

#### F3. Single oauth2-proxy sidecar builder + upgrade to ≥ v7.8

One function produces the sidecar's container definition (env, secrets, health, logging) for both the Lambda task-def path and the CDK task family. Upgrade the image to a digest-pinned release ≥ v7.8.0.

<a id="f4"></a>

#### F4. Per-pod owner authorization (opt-in)

`pod-up` accepts an `owner` identity (email or IdP login). The registry stores it. With `auth.browser.ownerOnly: true`: GitHub pods get `GITHUB_USER=<owner>[,admins]`; OIDC/Entra pods get an init container that writes `--authenticated-emails-file` into a shared ephemeral volume. `auth.browser.adminUsers` grants break-glass access.

<a id="b4"></a>

#### B4. Document the Microsoft tunnel data path and limits

Update `docs/delivery-modes.md` with the relay path, encryption scope, `devtunnels.ms` caveat, service limits, no-SLA status, and egress domains.

<a id="a3-spike"></a>

#### A3-spike. WorkOS Connect as an oauth2-proxy OIDC provider

Answer: ID token `email`/`email_verified` presence; wildcard redirect URIs for Connect apps; `org_id` usefulness for restriction; oauth2-proxy issuer verification. Output a go/no-go and adjust A3.

<a id="c1-spike"></a>

#### C1-spike. Remote-SSH to a Fargate task over ECS Exec port forwarding

Answer: does `AWS-StartPortForwardingSession` to an `ecs:<cluster>_<task>_<runtime>` target carry a VS Code Remote-SSH session end to end; latency; whether IAM can scope `ecs:ExecuteCommand`/`ssm:StartSession` by the task's `Owner` tag. Output a go/no-go.

### Wave 2: providers and tunnel account choice

<a id="a2"></a>

#### A2. Microsoft Entra ID browser provider

`auth.browser.provider: entra-id` with tenant ID, `allowedTenants`, `allowedGroups`, optional `User.Read` scope. Setup doc covers app registration, client secret, and "assignment required". Until A5 lands, each pod callback must be registered manually (≤ 256).

<a id="a3"></a>

#### A3. WorkOS browser provider

`auth.browser.provider: oidc` profile for WorkOS (issuer = AuthKit domain). Setup doc for the Connect application. Wildcard callback if the spike confirms it.

<a id="a4"></a>

#### A4. Generic OIDC recipes

Documented, schema-validated example configs for Okta, Auth0, Google Workspace, and Keycloak on the A3 code path.

<a id="b1"></a>

#### B1. Tunnel account provider choice

`auth.tunnel.provider: github|microsoft` plus an optional per-pod override on `pod-up`. The tunnel entrypoint runs `code tunnel user login --provider <p>` before `code tunnel`. Note Entra Conditional Access may block device-code flow.

<a id="b3"></a>

#### B3. Tunnel slot hygiene

The tunnel entrypoint traps `SIGTERM` and runs `code tunnel unregister` within the ECS stop timeout. `pod-up` warns when an owner already has 10 or more registered tunnel pods.

<a id="f5"></a>

#### F5. `npm run init` provider selection

The init wizard prompts for browser provider (and issuer/tenant), tunnel provider, and `ownerOnly`, and writes a schema-valid `auth:` block.

<a id="f6"></a>

#### F6. Deployment decision guide

New `docs/choosing-auth-and-access.md` mapping IdP × delivery style × remote-access backend, plus updates to CLAUDE.md §2 and rule 6, `setup-*.md`, and `delivery-modes.md`. Extended as Waves 3 and 4 land.

### Wave 3

<a id="a5"></a>

#### A5. Central auth host (single callback URL)

Optional `auth.browser.centralAuthHost: true`: an always-on oauth2-proxy ECS service behind `auth.<baseDomain>`; pod sidecars use `--redirect-url=https://auth.<base>/oauth2/callback`, `--cookie-domain=.<base>`, `--whitelist-domain=.<base>`. Requires F4 (with a shared cookie, per-pod checks are mandatory when enabled). ADR 0009. Adds roughly $3-9/month.

<a id="b2"></a>

#### B2. Persist tunnel login (existing issue #120)

Extend #120 to cover both GitHub and Microsoft tokens; depends on B1.

### Wave 4

<a id="c0"></a>

#### C0. SSH pod mode (shared base) + ADR 0010

New `mode: ssh` with `remote.backend: ssm|cloudflare|tailscale`. Runtime image runs non-root `sshd` on 2222 (key/cert only). The entrypoint selects the backend. `pod-up` prints an SSH config snippet; `scripts/pod-connect.ts` generates it. ADR covers the security scope of shell access.

<a id="c1"></a>

#### C1. AWS Session Manager backend

Per-mode `enableExecuteCommand`, `ssmmessages:*` on the task role, SSM VPC endpoints when `useVpcEndpoints`, IAM policy scoped by `Owner` tag, IAM Identity Center federation doc.

<a id="c2"></a>

#### C2. Cloudflare Tunnel + Access backend

`cloudflared` in the pod; pod-manager creates/deletes a per-pod hostname and Access application via the Cloudflare API (token in Secrets Manager, created by the user with `aws secretsmanager create-secret` so bootstrap does not change); clients use `cloudflared access ssh` as `ProxyCommand`.

### Later

<a id="c3"></a>

#### C3. Tailscale backend

Userspace-networking `tailscaled`, ephemeral tagged auth key in Secrets Manager, ACLs tying pods to owners.

<a id="c4"></a>

#### C4. opkssh identity layer

`sshd` accepts OIDC-bound keys so the IdP also governs SSH login; complements C1.

<a id="a9"></a>

#### A9. ALB-less browser mode via Cloudflare Tunnel + Access

Optional cluster shape without ALB/ACM (saves ~$16/month); domain must be on Cloudflare. Reuses C2 plumbing.

### Deferred (parking lot)

<a id="deferred"></a>

| ID | Item | Revisit when |
|---|---|---|
| A6 | Entra redirect-URI automation via Graph API | A5 proves unworkable for an Entra deployment |
| A7 | ALB native `authenticate-oidc` mode | A use case needs sidecar-free browser pods |
| A8 | Cognito broker for multiple simultaneous IdPs | A deployment needs more than one IdP active |
| B5 | Tenant/org-wide tunnel access | `code tunnel` exposes `devtunnel`-style `--tenant`/`--organization` access |
| C5 | Self-hosted access proxy (Teleport/Pomerium/Boundary) | Audit trail or session recording becomes a requirement |

## Sources

- WorkOS: [OpenID configuration](https://workos.com/docs/reference/workos-connect/metadata/openid-configuration.md), [Connect OAuth apps](https://workos.com/docs/authkit/connect/oauth.md), [wildcard redirect URIs](https://workos.com/docs/sso/redirect-uris/wildcard-characters)
- Microsoft: [redirect URI restrictions](https://learn.microsoft.com/entra/identity-platform/reply-url), [dev tunnels security](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security), [dev tunnels FAQ](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/faq), [dev tunnels limits](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits#dev-tunnels-limits), [VS Code Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels)
- oauth2-proxy: [Entra ID provider](https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/ms_entra_id), [configuration flags](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview), [CHANGELOG (v7.8.0 adds entra-id)](https://github.com/oauth2-proxy/oauth2-proxy/blob/master/CHANGELOG.md)
- AWS: [ALB user authentication](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
