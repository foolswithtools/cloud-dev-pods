"""Generate ../browser-request-path.svg (sequence diagram, Style 1)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _svglib import Sequence, Svg  # noqa: E402

svg = Svg(
    1240, 1000,
    "Browser pod request path",
    "domain.strategy: byo (HTTPS). alb-default serves HTTP on the ALB DNS name with no Route 53 record.",
)
seq = Sequence(svg, [
    ("browser", "Browser", "user's laptop", "blue"),
    ("r53", "Route 53", "*.<baseDomain> alias", "gray"),
    ("alb", "ALB listener", ":443 host-header rules", "purple"),
    ("proxy", "oauth2-proxy", "sidecar :4180", "orange"),
    ("idp", "Identity provider", "GitHub / Entra ID / OIDC", "teal"),
    ("vscode", "openvscode-server", "127.0.0.1:3000", "green"),
    ("efs", "EFS /workspace", "per-pod access point", "gray"),
], box_w=150)

seq.note(("alb", "proxy"), [
    "First ~30 s after pod-up: target group health check GET /ping every 15 s,",
    "2 healthy checks needed, so the ALB can answer 502 until the target is healthy.",
], tint="red", nid="note-502")

seq.msg("m-dns", "browser", "r53", "resolve <pod>.<baseDomain>")
seq.msg("m-dns-r", "r53", "browser", "ALB alias", color="gray", dashed=True)
seq.msg("m-https", "browser", "alb", "HTTPS GET (port 80 redirects to 443)")
seq.note("alb", [
    "host-header <pod>.<baseDomain> -> pod target group",
    "no matching rule -> fixed 404 response",
], tint="purple", nid="note-rule")
seq.msg("m-fwd", "alb", "proxy", "forward to task IP :4180")

f = seq.frame_open()
seq.msg("m-redirect", "proxy", "browser", "302 to IdP sign-in", color="purple")
seq.msg("m-signin", "browser", "idp", "user signs in", color="purple")
seq.msg("m-callback", "idp", "browser", "302 /oauth2/callback?code=...", color="purple", dashed=True)
seq.msg("m-cb-proxy", "browser", "proxy", "GET /oauth2/callback (via ALB)", color="purple")
seq.msg("m-token", "proxy", "idp", "redeem code, read identity", color="purple")
seq.note("proxy", [
    "Allowlist check (env set by pod-manager):",
    "org / users / groups / tenants / email domains,",
    "owner-only: GITHUB_USERS or emails file",
], tint="orange", nid="note-allow")
seq.msg("m-cookie", "proxy", "browser", "Set-Cookie (session, cookie secret) + 302", color="purple")
seq.frame_close("frame-login", f, "alt", "no valid session cookie", x0=30, x1=1050)

seq.msg("m-req", "browser", "proxy", "request + session cookie (via ALB)")
seq.msg("m-up", "proxy", "vscode", "proxy to http://127.0.0.1:3000")
seq.msg("m-efs", "vscode", "efs", "read/write /workspace (TLS, IAM)", color="green")
seq.msg("m-ui", "vscode", "browser", "VS Code UI + WebSocket (back through proxy and ALB)", color="gray",
        dashed=True)

bottom = seq.y - 10
seq.heads(bottom)
svg.legend(60, bottom + 34, [
    ("blue", False, "request"),
    ("purple", False, "OAuth sign-in (once per session)"),
    ("green", False, "workspace I/O"),
    ("gray", True, "response"),
])

svg.height = int(bottom + 64)
svg.write(Path(__file__).parent.parent / "browser-request-path.svg")
