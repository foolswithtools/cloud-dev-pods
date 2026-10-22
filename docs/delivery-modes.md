# Delivery modes: browser vs tunnel

cloud-dev-pods supports two ways of getting your editor onto a pod.

## Browser mode (default)

You access the pod via a browser at `https://<pod>.<base-domain>`. The ALB authenticates you via GitHub OAuth (org-allowlisted) before any traffic reaches the openvscode-server container.

Pros:

- Nothing to install locally beyond a browser.
- Works on locked-down corporate laptops.
- URL is shareable (with auth).

Cons:

- Browser-based VS Code is not 1:1 with VS Code Desktop (some extensions don't run).
- Requires ALB + ACM cert + DNS to be set up.

## Tunnel mode

You launch a pod with `mode=tunnel`. The pod runs `code tunnel` which dials out to Microsoft's tunnel broker. You connect from local VS Code Desktop via `Remote Tunnels: Connect to Tunnel`.

Pros:

- Full VS Code Desktop experience.
- No ALB, no DNS, no ACM cert needed.
- Works from any network with outbound HTTPS.

Cons:

- Authentication is via a GitHub or Microsoft device-code flow on **every `pod-up`**, including a `pod-down` / `pod-up` of the same pod name. The CLI's login can't be carried to a new task without storing a plaintext token on EFS, so it isn't persisted (see #68; persisting it via Secrets Manager is tracked in #120).
- Can't share a tunnel with multiple users.
- All editor traffic is relayed through Microsoft's dev tunnels service, a free preview service with monthly per-user limits and no SLA. See [Data path, limits and egress](#data-path-limits-and-egress).

### Tunnel account: GitHub or Microsoft

Microsoft dev tunnels accept a GitHub account or a Microsoft account, including an Entra ID work or school account. The pod and your local VS Code Desktop must sign in with the **same** account.

GitHub is the default. To use a Microsoft account for every tunnel pod, set it in `config/config.yaml` and re-run `cluster-up`:

```yaml
auth:
  tunnel:
    provider: microsoft   # github (default) | microsoft
```

To pick the account for one pod, pass the `tunnel_provider` input to `pod-up`. The default, `config`, uses `auth.tunnel.provider`:

```bash
gh workflow run pod-up.yml -f pod_name=dev -f mode=tunnel -f tunnel_provider=microsoft
```

On start the pod runs `code tunnel user login --provider <github|microsoft>`, then `code tunnel`. The workflow summary shows the device-code URL and code. For Microsoft that is `https://login.microsoft.com/device` and for GitHub `https://github.com/login/device`. Open it on your laptop, enter the code and sign in. Then in VS Code Desktop, sign in to Remote Tunnels with the same account and run `Remote Tunnels: Connect to Tunnel`.

**Entra Conditional Access caveat.** The pod signs in with the OAuth device code flow. Microsoft recommends that organizations [block device code flow with Conditional Access](https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-authentication-flows), and many tenants do. Under such a policy the sign-in page refuses the code, the login never completes, and the pod stops when the code expires (about 15 minutes). Ask your Entra administrator for an exception that covers your users, or use `provider: github`. A personal Microsoft account is not subject to your tenant's policies.

### Tunnel slots: the 10-tunnel cap

Microsoft dev tunnels allow 10 registered tunnels per account. Registering an eleventh makes the VS Code CLI delete a random unused tunnel, which can be another of your pods' tunnels.

`pod-down` frees the slot. ECS sends the tunnel container `SIGTERM`, and the entrypoint stops `code tunnel` and runs `code tunnel unregister` (bounded to 20 seconds, inside the container's 30-second stop timeout), so the tunnel leaves your Remote Tunnels list straight away instead of at the 30-day inactivity expiry. A task that dies without `SIGTERM`, such as a crash or an out-of-memory kill, still leaves its tunnel registered until that expiry.

`pod-up` counts the registry's running tunnel pods with the same owner. At 10 or more it still launches the pod, but adds a cap warning to the result and the workflow summary. The count covers only this cluster's pods: tunnels the same account registered elsewhere aren't visible without the user's token.

### Data path, limits and egress

Check these facts before a compliance review or capacity plan for tunnel mode. They come from Microsoft's documentation, linked below, as of October 2026. Microsoft can change them.

**Data path.** The pod and your laptop both make outbound connections to Microsoft's dev tunnels relay (`*.rel.tunnels.api.visualstudio.com`). Microsoft documents no direct or peer-to-peer path, so all editor traffic (file edits, terminal, extension host, debugging) passes through Microsoft's service. Neither end needs an inbound port.

**Encryption.** VS Code runs an SSH connection over the tunnel for end-to-end encryption; [VS Code's tunnel docs](https://code.visualstudio.com/docs/remote/tunnels) name AES-256 in CTR mode as the preferred cipher. The relay carries that traffic but can't read it. Forwarded-port web URLs are different. When you forward a port and open its `*.devtunnels.ms` URL (for example from the Ports view), [TLS terminates at Microsoft's ingress](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security#web-forwarding) with Microsoft-issued certificates and the service rewrites headers. That traffic is visible to Microsoft. Don't send data through a `*.devtunnels.ms` URL that must not be seen by a third party.

**Limits.** The [dev tunnels limits](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits#dev-tunnels-limits) apply per account (the GitHub or Microsoft account the pod signs in with) and reset monthly:

| Resource | Limit |
|---|---|
| Bandwidth | 5 GB per user |
| Tunnels | 10 per user |
| Ports | 10 per tunnel |
| Active connections | 1000 per port |
| HTTP request rate | 1500 per minute per port |
| Data transfer rate | Up to 20 MB/s per tunnel |
| Web-forwarding HTTP request body | 16 MB |

Registering an 11th tunnel makes the VS Code CLI delete a random unused one, and [unused tunnels are deleted after 30 days of no activity](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/faq#when-are-unused-dev-tunnels-deleted). [Tunnel slots](#tunnel-slots-the-10-tunnel-cap) covers how `pod-down` and `pod-up` deal with both.

**Service status.** Dev tunnels is [in public preview](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview): "This preview version is provided without a service-level agreement, and it's not recommended for production workloads." Microsoft publishes no pricing page and no paid tier, so there's no charge and no way to buy higher limits or an SLA. If the relay is down, tunnel pods can't be reached; browser pods don't use it.

**What counts toward the 5 GB.** Only traffic that crosses the tunnel: editor sessions, terminal output, file transfers and forwarded-port previews. Forwarded web previews are the usual way to use it up. The pod's own internet traffic (`git clone`, `npm install`, container image pulls, the VS Code server download) leaves the VPC through the NAT gateway (or the VPC endpoints, for AWS services, when `network.useVpcEndpoints` is on) and never touches the relay, so it doesn't count. That follows from the cluster's network layout rather than from a Microsoft statement. NAT traffic is billed by AWS per GB instead; see [`cost-controls.md`](cost-controls.md).

**Egress domains.** If you restrict the pods' outbound traffic (for example with a firewall in front of the NAT gateway), allow these from the private subnets. The first two groups come from [Microsoft's dev tunnels domain list](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security#domains), the third from [VS Code's network list](https://code.visualstudio.com/docs/setup/network):

- Login: `github.com` (GitHub tunnel account) or `login.microsoftonline.com` (Microsoft tunnel account).
- Relay: `global.rel.tunnels.api.visualstudio.com`, `<clusterId>.rel.tunnels.api.visualstudio.com`, `<clusterId>-data.rel.tunnels.api.visualstudio.com`, `*.<clusterId>.devtunnels.ms` and `*.devtunnels.ms`. Microsoft lists the current cluster IDs at `https://global.rel.tunnels.api.visualstudio.com/api/v1/clusters`. Wildcards are simplest: `*.rel.tunnels.api.visualstudio.com` and `*.devtunnels.ms`.
- VS Code server and extensions: `update.code.visualstudio.com` and `vscode.download.prss.microsoft.com` (the image contains only the CLI, which downloads the matching VS Code server when a client first connects), plus `marketplace.visualstudio.com`, `*.gallery.vsassets.io` and `*.gallerycdn.vsassets.io` for extensions installed on the pod.

Your laptop needs the same relay domains and the device-code page for your account (`github.com/login/device` or `login.microsoft.com/device`). Your own workloads need whatever else they use, such as package registries.

If traffic must not pass through a third party, tunnel mode isn't suitable. The remote-access alternatives in [#129](https://github.com/foolswithtools/cloud-dev-pods/issues/129) (Wave 4: Remote-SSH over AWS Session Manager and others) are meant for that case.

## When to use which

| Use case | Pick |
|---|---|
| Shared dev environment for a team review | Browser |
| Heavy extension use (Pylance, Copilot Chat, Jupyter) | Tunnel |
| Locked-down laptop, can't install VS Code Desktop | Browser |
| Want to use VS Code Settings Sync seamlessly | Tunnel |
| Traffic must not transit a third party | Browser (traffic stays on your ALB), or for VS Code Desktop the remote-access alternatives in epic [#129](https://github.com/foolswithtools/cloud-dev-pods/issues/129) (Wave 4). Not tunnel: see [Data path, limits and egress](#data-path-limits-and-egress) |
