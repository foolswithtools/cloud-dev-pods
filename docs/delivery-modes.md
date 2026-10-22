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

## When to use which

| Use case | Pick |
|---|---|
| Shared dev environment for a team review | Browser |
| Heavy extension use (Pylance, Copilot Chat, Jupyter) | Tunnel |
| Locked-down laptop, can't install VS Code Desktop | Browser |
| Want to use VS Code Settings Sync seamlessly | Tunnel |
