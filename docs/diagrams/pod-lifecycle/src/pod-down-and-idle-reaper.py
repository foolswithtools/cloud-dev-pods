"""Generate pod-down-and-idle-reaper.svg (the three ways a pod is stopped)."""

from pathlib import Path

from svgkit import TEXT, TEXT2, Svg

OUT = Path(__file__).parent.parent / "pod-down-and-idle-reaper.svg"

s = Svg(1360, 920, "How a pod stops: pod-down, idle reaper, task-stopped cleanup",
        "Every path ends in the same pod-manager down action")

WF = dict(fill="#eff6ff", stroke="#3b82f6")
EB = dict(fill="#faf5ff", stroke="#a855f7")
END = dict(fill="#f9fafb", stroke="#9ca3af")

# idle-reaper container
s.frame(330, 190, 1010, 465, "idle-reaper Lambda")
s.text(1032, 204, "function pod-idle-reaper, two EventBridge rules", size=11.5, color="#334155", italic=True)

# -- edges -------------------------------------------------------------------
s.arrow([(155, 170), (155, 700)], "blue")
s.label(165, 250, ["pod-cli Invoke", "{action: down,", " keepWorkspace}", "pod-ops role", "(OIDC)"], bg=False)

s.arrow([(480, 170), (480, 230)], "purple", dashed=True)
s.arrow([(590, 280), (650, 280)], "gray")
s.label(620, 272, "no", anchor="middle", bg=False)
s.arrow([(480, 330), (480, 380)], "purple", dashed=True)
s.label(490, 360, "yes", bg=False)
s.arrow([(590, 430), (650, 430)], "gray")
s.label(620, 422, "no", anchor="middle", bg=False)
s.arrow([(480, 480), (480, 530)], "purple", dashed=True)
s.label(490, 510, "yes", bg=False)
s.arrow([(590, 580), (650, 580)], "gray")
s.label(620, 572, "no", anchor="middle", bg=False)
s.arrow([(480, 630), (480, 700)], "purple", dashed=True)
s.label(490, 676, "yes: invoke down, keepWorkspace=true", bg=False)

s.arrow([(1020, 170), (1020, 230)], "purple", dashed=True)
s.arrow([(1120, 280), (1170, 280)], "gray")
s.label(1145, 272, "no", anchor="middle", bg=False)
s.arrow([(1020, 330), (1020, 700)], "purple", dashed=True)
s.label(1030, 500, ["yes: invoke down,", "keepWorkspace=true"], bg=False)

# CloudWatch annotation for D2
s.label(650, 488, ["CloudWatch RequestCount Sum over", "idleMinutes; no datapoints = active"], bg=False)

# -- nodes -------------------------------------------------------------------
s.node(40, 100, 230, 70, "pod-down workflow", ["pod-down.yml, keep_workspace", "input (default true)"], **WF)
s.node(360, 100, 240, 70, "EventBridge schedule", ["IdleScanSchedule", "rate(5 minutes)"], **EB)
s.node(900, 100, 240, 70, "EventBridge rule", ["TaskStateChangeRule: ECS Task", "State Change, lastStatus STOPPED"], **EB)

s.diamond(480, 280, 220, 100, ["browser pod past", "its idle window?"])
s.diamond(480, 430, 220, 100, ["0 requests in", "idle window?"])
s.diamond(480, 580, 220, 100, ["idleSince", "already set?"])
s.diamond(1020, 280, 200, 100, ["registry row", "with taskArn?"])

s.node(650, 250, 220, 60, "Skip pod", ["tunnel, idleMinutes 0, or younger", "than its window (#229)"], size=13, **END)
s.node(650, 400, 220, 60, "Clear idleSince", ["REMOVE idleSince if it was set"], size=13, **END)
s.node(650, 550, 220, 60, "Warn first", ["SET idleSince = now,", "SNS publish idle warning"], size=13,
       fill="#fff7ed", stroke="#f97316")
s.node(1170, 250, 150, 60, "Nothing to clean", ["already removed"], size=13, **END)

# pod-manager down: one wide node with the ordered cleanup list
x, y, w, h = 60, 700, 1100, 168
s.add(f'<rect data-graph-role="node" x="{x}" y="{y}" width="{w}" height="{h}" rx="8" ry="8" '
      f'fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>')
s.text(x + 20, y + 28, "pod-manager Lambda: down action (podDown)", size=15, color=TEXT, weight=600)
s.text(x + 20, y + 48, "registryGet(podName); no row returns not-found. Then, in order:", size=12.5, color=TEXT2)
steps = [
    ("1", "ecs:StopTask on the registered task (errors logged, not fatal)"),
    ("2", "elbv2:DeleteRule, the pod's host-header listener rule (browser pods)"),
    ("3", "elbv2:DeregisterTargets (task IP), wait 5 s, DeleteTargetGroup (browser pods)"),
    ("4", "efs:DeleteAccessPoint ONLY when keepWorkspace=false; files stay on EFS either way"),
    ("5", "dynamodb:DeleteItem, the registry row"),
]
for i, (n, t) in enumerate(steps):
    ty = y + 74 + i * 19
    s.add(f'<circle cx="{x + 30}" cy="{ty - 4}" r="7.5" fill="#16a34a"/>')
    s.text(x + 30, ty, n, size=10.5, color="#ffffff", anchor="middle", weight=700)
    s.text(x + 46, ty, t, size=12.5, color=TEXT)

s.legend(40, 896, [
    ("arrow", "blue", "manual trigger (workflow)"),
    ("dashed", "purple", "automatic (EventBridge, reaper)"),
    ("arrow", "gray", "no-op branch"),
], gap=40)

s.write(OUT)
print(f"wrote {OUT}")
