"""Generate ../tunnel-device-code-flow.svg (sequence diagram, Style 1)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _svglib import Sequence, Svg  # noqa: E402

svg = Svg(
    1240, 1000,
    "Tunnel pod: device-code sign-in",
    "pod-up -f mode=tunnel. No ALB, no oauth2-proxy: the pod dials out, and the dev tunnel service checks the account.",
)
seq = Sequence(svg, [
    ("gha", "pod-up.yml", "GitHub Actions, PodOps role", "gray"),
    ("lambda", "pod-manager", "Lambda", "purple"),
    ("task", "vscode-tunnel", "ECS task (code CLI)", "green"),
    ("cwl", "CloudWatch Logs", "/cloud-dev-pods/dev/pods", "orange"),
    ("user", "User", "laptop browser + VS Code", "blue"),
    ("idp", "GitHub / Microsoft", "device login page", "teal"),
    ("tunnels", "Dev tunnel service", "Microsoft (internet)", "gray"),
], box_w=150)

seq.msg("m-invoke", "gha", "lambda", "pod-cli up (lambda Invoke)")
seq.msg("m-run", "lambda", "task", "register task def + RunTask")
seq.note("task", [
    "env POD_NAME, TUNNEL_PROVIDER = github | microsoft",
    "(auth.tunnel.provider or tunnel_provider input)",
], tint="green", nid="note-env")
seq.msg("m-result", "lambda", "gha", "taskArn, tunnelProvider", color="gray", dashed=True)

f = seq.frame_open()
seq.msg("m-login", "task", "cwl", "code tunnel user login --provider: device-code prompt", color="orange")
seq.msg("m-poll", "gha", "cwl", "tunnel-poll-logs.ts: FilterLogEvents, this task's stream only, every 5 s (180 s max)",
        color="orange")
seq.msg("m-code", "cwl", "gha", "{url, code}", color="orange", dashed=True)
seq.msg("m-summary", "gha", "user", "workflow summary: Open <url>, Code <code>", color="orange")
seq.msg("m-signin", "user", "idp", "enter code, sign in", color="purple")
seq.msg("m-token", "idp", "task", "device flow completes; CLI stores the login", color="purple", dashed=True)
seq.frame_close("frame-login", f, "opt", "no stored login (code tunnel user show fails)", x0=30, x1=1210)

seq.msg("m-register", "task", "tunnels", "code tunnel --name <pod>: outbound HTTPS via NAT")
seq.msg("m-connect", "user", "tunnels", "VS Code Desktop: Connect to Tunnel <pod> (same account)")
seq.msg("m-relay", "tunnels", "task", "relayed session to the pod's VS Code server")

f2 = seq.frame_open()
seq.msg("m-unreg", "task", "tunnels", "SIGTERM trap: code tunnel unregister (frees 1 of 10 slots)", color="red")
seq.frame_close("frame-down", f2, "opt", "pod-down (ECS sends SIGTERM, 30 s stopTimeout)", x0=30, x1=1210)

bottom = seq.y - 10
seq.heads(bottom)
svg.legend(60, bottom + 34, [
    ("blue", False, "tunnel connection"),
    ("orange", False, "device-code relay"),
    ("purple", False, "account sign-in"),
    ("red", False, "cleanup"),
    ("gray", True, "response"),
])

svg.height = int(bottom + 64)
svg.write(Path(__file__).parent.parent / "tunnel-device-code-flow.svg")
