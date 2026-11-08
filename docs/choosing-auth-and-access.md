# Choosing sign-in and access

This guide helps you pick how people reach their pods and which account they sign in with. It covers only what ships today: browser pods with GitHub, Microsoft Entra ID or any other OpenID Connect identity provider, and tunnel pods with a GitHub or Microsoft account. Options that haven't shipped are listed at the end with their issues.

For the general browser-vs-tunnel trade-offs (extensions, Settings Sync, shareable URLs), see the [use-case table in delivery modes](delivery-modes.md#when-to-use-which).

## Questions to answer first

1. **Do you control a DNS domain with a Route53 hosted zone?**
   - No: use **tunnel** pods and `domain.strategy: alb-default`. Browser pods need each pod's hostname to resolve, and `alb-default` serves plain HTTP for non-production use.
   - Yes: browser and tunnel are both open to you. Set `domain.strategy: byo`.
2. **Will people use a web browser or VS Code Desktop?**
   - Browser: go to question 3.
   - VS Code Desktop: use **tunnel** pods and go to question 4.
   - Both: you can run both kinds of pod in one cluster. Answer questions 3 and 4.
3. **Browser pods: which identity provider does your team sign in with?**
   - GitHub accounts: `auth.browser.provider: github` (the default), restricted with `allowedUsers` or `allowedOrg`.
   - Microsoft 365 / Entra ID work or school accounts: `auth.browser.provider: entra-id`. It requires `domain.strategy: byo`.
   - Any other OpenID Connect identity provider (Okta, Auth0, Keycloak, Google Workspace and so on): `auth.browser.provider: oidc`. It requires `domain.strategy: byo`, and is restricted with `allowedEmailDomains`, `allowedGroups` or `ownerOnly`.
   - Should each pod admit only its owner? Set `auth.browser.ownerOnly: true` with any provider.
4. **Tunnel pods: which account will the pod and your laptop sign in with?**
   - GitHub account: `auth.tunnel.provider: github` (the default).
   - Microsoft account (personal, or Entra work or school): `auth.tunnel.provider: microsoft`. Check the [Conditional Access caveat](delivery-modes.md#tunnel-account-github-or-microsoft) first if it is a work or school account.
5. **Must editor traffic stay off third-party networks?** Then don't use tunnel pods: their traffic goes through Microsoft's dev tunnels relay. Browser pods keep editor traffic on your own ALB. See [Data path, limits and egress](delivery-modes.md#data-path-limits-and-egress).

## Browser pods

| Provider | Status | Domain strategy | Callback URLs | `ownerOnly` | Cost |
| --- | --- | --- | --- | --- | --- |
| GitHub | Supported. Setup: [CLI walkthrough](setup-cli.md#browser-mode-only-register-the-oauth-app) | `byo`. Each pod needs a resolvable `https://<pod>.<base-domain>` | A GitHub OAuth App accepts one callback URL, so one registered callback per pod today: the app's callback must name the pod's hostname | Supported: matches GitHub logins. See [per-pod owner authorization](operating.md#per-pod-owner-authorization) | No charge for the OAuth App. The ALB is in the cluster's idle cost either way (see [cost controls](cost-controls.md)) |
| Microsoft Entra ID | Supported. Setup: [Entra ID setup](setup-entra.md) | `byo` is required: Entra accepts only `https` redirect URIs, and synth refuses `entra-id` with `alb-default` | One redirect URI per pod, each registered on the app by hand; Entra caps an app at 256 (100 if it also admits personal accounts). See [the redirect URI ceiling](setup-entra.md#the-redirect-uri-ceiling) | Supported: matches the `email` claim, which needs a mailbox. Across several tenants, read [owner-only across tenants](setup-entra.md#multi-tenant-apps) | No AWS cost beyond the cluster's idle cost. The Entra app registration and its client secret need an Entra tenant; secrets expire after at most 24 months |
| Generic OIDC | Supported. Setup: the commented `oidc` block in [`config/config.example.yaml`](../config/config.example.yaml); per-IdP recipes are coming in [#139](https://github.com/foolswithtools/cloud-dev-pods/issues/139) | `byo` is required: synth refuses `oidc` with `alb-default`, which serves pods over HTTP | One redirect URI per pod, `https://<pod>.<base-domain>/oauth2/callback`, each registered at the IdP | Supported: matches the `email` claim | No AWS cost beyond the cluster's idle cost |

Every provider refuses a browser `pod-up` until at least one sign-in restriction is set. The keys that count differ by provider; see [troubleshooting](troubleshooting.md#browser-pod-up-fails-with-refusing-browser-mode-pod-up-authbrowserprovider--has-no-sign-in-restriction).

With `provider: oidc`, synth refuses `allowedOrg`, `allowedUsers` and `allowedTenants`, because they do nothing for a generic IdP. `scope`, `groupsClaim` and `insecureAllowUnverifiedEmail` are oidc-only: synth refuses them with `github` or `entra-id`.

### Central auth host

Without it, every browser pod's oauth2-proxy completes its own sign-in, so each pod needs its own registered callback URL (the "Callback URLs" column above). With `auth.browser.centralAuthHost: true`, `cluster-up` runs one more oauth2-proxy at `https://auth.<base-domain>`. It completes every sign-in and sets one session cookie on `.<base-domain>`, and you register a single callback for every pod: `https://auth.<base-domain>/oauth2/callback`. It works with all three providers. The design and its threat model are in [ADR 0009](adr/0009-central-auth-host.md). The service costs about $3-9 a month (see [cost controls](cost-controls.md)).

Every pod accepts that shared cookie, so each pod's oauth2-proxy checks the owner on every request. Synth refuses `centralAuthHost: true` unless all of these hold:

- `domain.strategy: byo` and `auth.browser.ownerOnly: true`.
- **`domain.baseDomain` holds only cloud-dev-pods records** (`auth.<base-domain>` and the pod hosts). The browser sends the shared cookie to every host under it, so any other server there (a company website, another app, a third-party CNAME, a dangling record someone took over) could read a signed-in user's cookie and replay it on that user's pods. Use a dedicated subdomain such as `pods.example.com`. Synth can't check this one; its error text reminds you.
- **`auth.browser.adminUsers` is empty.** An admin is admitted by every pod, so an admin's shared cookie captured on one pod (the pod's owner controls the code that receives it) would open every other pod. For break-glass access, recreate the pod with a new `owner` and a fresh workspace (`pod-down -f keep_workspace=false` first: code the old owner left in `/workspace` would run as the new owner), or turn `centralAuthHost` off.
- **A deployment-wide sign-in restriction**, which `auth.<base-domain>` enforces: `allowedOrg` or `allowedUsers` for github, `allowedTenants`, `allowedGroups` or `allowedEmailDomains` for entra-id, `allowedGroups` or `allowedEmailDomains` for oidc. `ownerOnly` doesn't count here, because the central host has no owner.

What changes for users:

- **github owners are email addresses**: the GitHub account's verified primary email, which is what the per-request check can compare. The workflow's default owner (the actor) is a login, so every `pod-up` passes `-f owner=<email>`. If an owner changes their primary email on GitHub, they lose access until the pod is recreated with the new owner.
- **Owners must also pass the deployment-wide allowlist** at sign-in; ownership only narrows who gets in on top of it. For github that means being in `allowedUsers` or `allowedOrg`, and an org member whenever `allowedOrg` is set (checked on every request). For entra-id and oidc it means matching the configured restrictions.
- **A 403 on someone else's pod signs you out of every pod.** oauth2-proxy clears the session cookie when the owner check fails, and that cookie is the shared one. Sign in again from your own pod.
- **A bookmarked `https://<pod>.<base-domain>/oauth2/start` ends on `https://auth.<base-domain>/`**, signed in, showing a bare "Authenticated" page. Go back to the pod URL. Opening the pod URL itself always returns you to the pod.
- The redirect whitelist (`.<base-domain>`) checks host and port but not the scheme, so `http://<pod>.<base-domain>/` passes it. That is harmless with `byo` (the HTTP listener redirects to HTTPS and the cookie is `Secure`), but nothing should rely on the whitelist for the scheme.
- Turning it on refuses every retained workspace created before workspaces recorded their owner (#191): `pod-down -f keep_workspace=false` those pods first. The browser pod's VS Code container also loses `CAP_NET_RAW` (no `tcpdump` or raw sockets), so a pod's owner can't capture a visitor's cookie off the wire.

## Tunnel pods

| Account | Status | Data path | Limits | Conditional Access |
| --- | --- | --- | --- | --- |
| GitHub | Supported (the default). Setup: [tunnel account](delivery-modes.md#tunnel-account-github-or-microsoft) | Editor traffic goes through Microsoft's dev tunnels relay, end-to-end encrypted; forwarded-port `*.devtunnels.ms` URLs terminate TLS at Microsoft. See [data path](delivery-modes.md#data-path-limits-and-egress) | Per account, monthly: 5 GB bandwidth, 10 tunnels. Free preview with no SLA. See [tunnel slots](delivery-modes.md#tunnel-slots-the-10-tunnel-cap) | Not affected |
| Microsoft (personal or Entra work or school) | Supported. Setup: [tunnel account](delivery-modes.md#tunnel-account-github-or-microsoft) | Same relay as GitHub | Same limits as GitHub | Work or school accounts: tenants that block the device code flow refuse the pod's sign-in, and the pod stops when the code expires. Ask your Entra administrator for an exception or use GitHub. Personal Microsoft accounts are not affected |

With either account, the pod signs in with a device code on every `pod-up`, and your local VS Code Desktop must sign in to Remote Tunnels with the same account. Tunnel pods ignore `auth.browser`, including `ownerOnly`, and the idle reaper doesn't stop them.

## Not shipped yet

- **WorkOS** (via the `oidc` browser provider): [#138](https://github.com/foolswithtools/cloud-dev-pods/issues/138).
- **Per-IdP setup recipes** for the `oidc` provider (Okta, Auth0, Google Workspace, Keycloak): [#139](https://github.com/foolswithtools/cloud-dev-pods/issues/139). The provider itself ships; see [Browser pods](#browser-pods).
- **SSH pods with VS Code Remote-SSH** (planned). `pod-up.yml` doesn't offer `mode: ssh` yet, and every `remote.backend` is refused until its backend ships: AWS Session Manager [#146](https://github.com/foolswithtools/cloud-dev-pods/issues/146), Cloudflare Tunnel and Access [#147](https://github.com/foolswithtools/cloud-dev-pods/issues/147), Tailscale [#148](https://github.com/foolswithtools/cloud-dev-pods/issues/148).
- **Deferred options** are collected in the parking lot, [#151](https://github.com/foolswithtools/cloud-dev-pods/issues/151).
