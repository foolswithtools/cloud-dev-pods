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
- Authentication is via Microsoft's device-code flow (one-time per pod).
- Can't share a tunnel with multiple users.

## When to use which

| Use case | Pick |
|---|---|
| Shared dev environment for a team review | Browser |
| Heavy extension use (Pylance, Copilot Chat, Jupyter) | Tunnel |
| Locked-down laptop, can't install VS Code Desktop | Browser |
| Want to use VS Code Settings Sync seamlessly | Tunnel |
