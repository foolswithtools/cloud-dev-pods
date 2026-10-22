# ADR 0008: Pluggable browser identity provider

## Status

Accepted (2026-10-22). Amends [ADR 0002](0002-oauth2-proxy-sidecar.md).

## Context

[ADR 0002](0002-oauth2-proxy-sidecar.md) put `oauth2-proxy` in each browser pod's task as a sidecar, configured for a GitHub OAuth App. The config surface was named after GitHub too: `github.oauthAllowedOrg` and `github.oauthAllowedUsers` in `config/config.yaml`, passed to the pod-manager Lambda as `OAUTH_ALLOWED_ORG` / `OAUTH_ALLOWED_USERS`.

The [pluggable identity providers and remote access spec](../specs/pluggable-identity-remote-access.md) plans for Microsoft Entra ID, WorkOS and generic OIDC providers for browser pods, and for a choice of GitHub or Microsoft accounts for tunnel login. Each of those needs settings that do not fit under `github:` (issuer URL, tenants, groups, email domains). Adding them one provider at a time under provider-named keys would mean a schema change for every new provider.

## Decision

Add a provider-neutral `auth:` block to the config schema (`infra/lib/config/schema.ts`):

```yaml
auth:
  browser:
    provider: github            # github | entra-id | oidc (default github)
    issuerUrl: https://...      # OIDC issuer (oidc / entra-id)
    allowedOrg: my-org          # GitHub org
    allowedUsers: [alice, bob]  # IdP logins
    allowedGroups: []
    allowedEmailDomains: []
    allowedTenants: []          # Entra tenant IDs
    ownerOnly: false            # per-pod owner authorization (opt-in)
    adminUsers: []              # break-glass access when ownerOnly is on
  tunnel:
    provider: github            # github | microsoft (default github)
```

- **Keep the sidecar.** The ADR 0002 architecture is unchanged: `oauth2-proxy` stays a same-task sidecar on port 4180 in front of openvscode-server. Only the provider and its restrictions become configurable.
- **Backward compatibility.** `github.oauthAllowedOrg` and `github.oauthAllowedUsers` stay valid as deprecated aliases. When `auth.browser` is absent they map to `auth.browser.allowedOrg` and `auth.browser.allowedUsers` (the comma-separated user string becomes a list). When `auth.browser` is present it wins and the legacy keys are ignored. In both cases synth prints one deprecation warning.
- **Plumbing.** The resolved values reach the pod-manager Lambda as `AUTH_BROWSER_*` and `AUTH_TUNNEL_PROVIDER` environment variables, with list values JSON-encoded, and are parsed in `infra/lambda/pod-manager/env.ts`. `OAUTH_ALLOWED_ORG` / `OAUTH_ALLOWED_USERS` keep their names and format, sourced from `auth.browser`, until the sidecar builder and fail-fast guard move to the new fields.
- **Staged rollout.** The schema names every planned provider so later slices add values, not structure. Until a provider is wired at runtime, choosing it fails schema validation with a pointer to the epic ([#129](https://github.com/foolswithtools/cloud-dev-pods/issues/129)). When this ADR was accepted only `github` (browser) and `github` (tunnel) were wired.

## Consequences

- Existing configs keep synthesizing with no resource changes. The only template difference is the extra `AUTH_*` variables on the pod-manager Lambda.
- Users see a deprecation warning until they move to `auth.browser`. A future major release may drop the `github.oauthAllowed*` aliases.
- Later provider work (Entra ID, WorkOS, generic OIDC, tunnel account choice, per-pod owner authorization) changes the sidecar builder and guard, not the config schema shape.
- ADR 0002's consequence "GitHub org allowlist is one env var (`OAUTH2_PROXY_GITHUB_ORG`)" now applies only when `provider: github`. Other providers use their own oauth2-proxy settings.
