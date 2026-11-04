"""Generate pod-up-sequence.svg (pod-up.yml -> pod-manager Lambda -> AWS)."""

from pathlib import Path

from svgkit import TEXT2, Svg

OUT = Path(__file__).parent.parent / "pod-up-sequence.svg"

LANES = [
    ("dev", "Developer", "gh / Actions UI", ("#f9fafb", "#9ca3af")),
    ("wf", "pod-up.yml", "runner + pod-cli", ("#eff6ff", "#3b82f6")),
    ("sts", "AWS STS", "aws-oidc action", ("#f9fafb", "#9ca3af")),
    ("pm", "pod-manager", "Lambda", ("#fff7ed", "#f97316")),
    ("ddb", "DynamoDB", "registry table", ("#f0fdf4", "#22c55e")),
    ("ecr", "ECR", "runtime images", ("#f9fafb", "#9ca3af")),
    ("efs", "EFS", "access points", ("#f0fdf4", "#22c55e")),
    ("ecs", "ECS Fargate", "task def + task", ("#eff6ff", "#3b82f6")),
    ("elb", "ALB (ELBv2)", "TG + listener rule", ("#faf5ff", "#a855f7")),
    ("cw", "CloudWatch", "Logs", ("#f9fafb", "#9ca3af")),
]
X0, STEP = 100, 148
X = {k: X0 + i * STEP for i, (k, *_r) in enumerate(LANES)}
WIDTH = X0 * 2 + STEP * (len(LANES) - 1)
TOP = 96
HEAD_H = 50

events = []  # built below, rendered in one pass


def call(a, b, text, color="blue"):
    events.append(("call", a, b, text, color, False))


def ret(a, b, text, color="gray"):
    events.append(("call", a, b, text, color, True))


def self_(a, text):
    events.append(("self", a, text))


def open_(kind, cond, a, b):
    events.append(("open", kind, cond, a, b))


def else_(cond):
    events.append(("else", cond))


def close():
    events.append(("close",))


call("dev", "wf", "workflow_dispatch: pod_name, mode, owner, ...")
self_("wf", "teardown-lock: refuse while cluster-down runs")
call("wf", "sts", "AssumeRoleWithWebIdentity")
ret("sts", "wf", "pod-ops role credentials")
call("wf", "pm", "pod-cli: lambda Invoke {action: up}")
self_("pm", "zod schema, mode / sshPublicKey checks")
call("pm", "ddb", "GetItem podName", "green")
open_("opt", "[row exists]", "wf", "ddb")
ret("pm", "wf", "{ok: false, status: conflict}", "red")
close()
open_("opt", "[browser]", "pm", "ddb")
self_("pm", "auth guard + owner check: refuse if unrestricted")
close()
open_("opt", "[tunnel]", "pm", "ddb")
call("pm", "ddb", "Scan: owner's tunnel count", "green")
close()
call("pm", "ecr", "DescribeImages: newest tag (no image_tag)")
call("pm", "efs", "DescribeAccessPoints: match Pod tag")
open_("alt", "[access point found: reuse workspace]", "pm", "efs")
self_("pm", "reuse access point + POSIX uid")
else_("[none found]")
call("pm", "ddb", "Scan: free POSIX uid", "green")
call("pm", "efs", "CreateAccessPoint /pods/<pod>-<hex>")
close()
call("pm", "ecs", "RegisterTaskDefinition (browser: vscode + oauth2-proxy, + owner-authz-init if ownerOnly; tunnel: vscode-tunnel)")
open_("opt", "[browser]", "pm", "elb")
call("pm", "elb", "CreateTargetGroup cdp-<pod>, HTTP :4180", "purple")
call("pm", "elb", "CreateRule host-header, priority fnv1a % 49000 + 1000 (re-derived on PriorityInUse)", "purple")
close()
call("pm", "ecs", "RunTask (FARGATE, private subnets)")
open_("loop", "[every 5 s, up to 180 s]", "pm", "ecs")
call("pm", "ecs", "DescribeTasks until RUNNING")
close()
open_("opt", "[browser]", "pm", "elb")
call("pm", "elb", "RegisterTargets: task private IP :4180", "purple")
close()
call("pm", "ddb", "PutItem (attribute_not_exists)", "green")
ret("pm", "wf", "{ok, taskArn, url (browser), tunnelProvider (tunnel), warning}")
open_("opt", "[tunnel] tunnel-poll-logs.ts", "wf", "cw")
call("wf", "cw", "FilterLogEvents on this task's stream, every 5 s, up to 180 s")
ret("cw", "wf", "device-code URL + code (or {} on timeout)")
close()
ret("wf", "dev", "step summary: URL, or device code")

# -- layout pass ---------------------------------------------------------------
ROW = 36
y = TOP + HEAD_H + 34
last_bottom = y
plan = []
stack = []
for ev in events:
    kind = ev[0]
    if kind == "open":
        y0 = y - 24
        stack.append((ev, y0))
        y = y0 + 50
    elif kind == "else":
        dy = last_bottom + 10
        plan.append(("else", ev, dy))
        y = dy + 46
    elif kind == "close":
        ev0, y0 = stack.pop()
        y1 = last_bottom + 12
        plan.append(("frame-end", ev0, y0, y1))
        last_bottom = y1
        y = y1 + 36
    elif kind == "call":
        plan.append(("call", ev, y))
        last_bottom = y + 6
        y += ROW
    elif kind == "self":
        plan.append(("self", ev, y))
        last_bottom = y + 24
        y += ROW + 8
BOTTOM = y + 10
HEIGHT = int(BOTTOM + 96)

s = Svg(WIDTH, HEIGHT, "pod-up: workflow to running pod",
        "pod-up.yml invokes the pod-manager Lambda, the only holder of ECS / ALB / EFS write rights (ADR 0003)")

# lifelines + heads
for k, title, sub, (fill, stroke) in LANES:
    s.add(f'<line data-graph-role="decoration" x1="{X[k]}" y1="{TOP + HEAD_H}" x2="{X[k]}" y2="{BOTTOM}" '
          f'stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="4,4"/>')
for k, title, sub, (fill, stroke) in LANES:
    s.node(X[k] - 64, TOP, 128, HEAD_H, title, [sub], fill=fill, stroke=stroke, size=13)

# pod-manager activation bar (decoration)
first = next(p[2] for p in plan if p[0] == "call" and p[1][2] == "pm")
last = max(p[2] for p in plan if p[0] == "call" and p[1][1] == "pm" and p[1][2] == "wf")
s.add(f'<rect data-graph-role="decoration" x="{X["pm"] - 5}" y="{first}" width="10" height="{last - first}" '
      f'fill="#ffedd5" stroke="#f97316" stroke-width="1"/>')

FRAME_COLORS = {"opt": "#64748b", "alt": "#64748b", "loop": "#64748b"}
for p in plan:
    if p[0] == "frame-end":
        (_, fkind, cond, a, b), y0, y1 = p[1], p[2], p[3]
        x0 = min(X[a], X[b]) - 58
        x1 = max(X[a], X[b]) + 58
        s.frame(x0, y0, x1 - x0, y1 - y0, fkind, cond, color=FRAME_COLORS[fkind],
                note_x=X["pm"] + 14 if x0 < X["pm"] < x0 + 260 else None)
    elif p[0] == "else":
        # find enclosing frame extents (the alt): pm..efs
        s.divider(X["pm"] - 58, p[2], X["efs"] - X["pm"] + 116, p[1][1], note_x=X["pm"] + 14)

for p in plan:
    if p[0] == "call":
        _, a, b, text, color, dashed = p[1]
        yy = p[2]
        xa, xb = X[a], X[b]
        pad = 6 if a == "pm" else 2
        padb = 6 if b == "pm" else 2
        if xb > xa:
            pts = [(xa + pad, yy), (xb - padb, yy)]
        else:
            pts = [(xa - pad, yy), (xb + padb, yy)]
        s.arrow(pts, color, dashed=dashed, width=1.5)
        lo = min(xa, xb)
        s.label(lo + 12, yy - 6, text, size=11.5, color="#374151")
    elif p[0] == "self":
        _, a, text = p[1]
        yy = p[2]
        xa = X[a] + (6 if a == "pm" else 2)
        s.arrow([(xa, yy), (xa + 28, yy), (xa + 28, yy + 18), (xa + 2, yy + 18)], "gray", width=1.3)
        s.label(xa + 36, yy + 13, text, size=11.5, color="#374151")

note_y = BOTTOM + 28
s.label(40, note_y, [
    "Any error after the access-point step rolls back: StopTask, DeleteRule, DeleteTargetGroup, and DeleteAccessPoint only if this "
    "invocation created it (a reused workspace is never deleted). Refusals before that point (conflict, auth guard, no image) create no pod resources.",
], size=11.5, color=TEXT2, bg=False)
s.legend(40, note_y + 34, [
    ("arrow", "blue", "call (workflow / ECS / ECR / EFS)"),
    ("arrow", "green", "registry read / write"),
    ("arrow", "purple", "ALB (browser pods)"),
    ("dashed", "gray", "response"),
    ("dashed", "red", "refusal"),
], gap=30)

s.write(OUT)
print(f"wrote {OUT}  ({WIDTH}x{HEIGHT})")
