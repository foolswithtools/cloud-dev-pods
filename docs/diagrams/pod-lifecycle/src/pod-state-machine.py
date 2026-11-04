"""Generate pod-state-machine.svg (derived pod lifecycle states)."""

from pathlib import Path

from svgkit import Svg

OUT = Path(__file__).parent.parent / "pod-state-machine.svg"

s = Svg(1200, 900, "Pod lifecycle states",
        "State is derived, not stored: registry row · ECS task lastStatus · row.idleSince · EFS access point (Pod tag)")

W, H = 220, 76
C1, C2, C3 = 80, 490, 900
R1, R2, R3, R4 = 130, 330, 530, 730
STEADY = dict(fill="#ffffff", stroke="#94a3b8")
LIVE = dict(fill="#eff6ff", stroke="#3b82f6")
WARN = dict(fill="#fff7ed", stroke="#f97316")
TRANS = dict(fill="#f8fafc", stroke="#64748b", dashed=True)

# -- edges first (painter's order) -------------------------------------------
# initial pseudo-state
s.add('<circle data-graph-role="node" cx="190" cy="100" r="8" fill="#111827"/>')
s.arrow([(190, 108), (190, R1)], "gray")

# No pod <-> Starting
s.arrow([(C1 + W, 150), (C2, 150)], "blue")
s.label(395, 142, "pod-up, new access point", anchor="middle", bg=False)
s.arrow([(C2, 186), (C1 + W, 186)], "red")
s.label(395, 202, "fails: rollback, AP deleted", anchor="middle", bg=False)
# Retained <-> Starting
s.arrow([(C3, 150), (C2 + W, 150)], "blue")
s.label(805, 142, "pod-up, reuse access point", anchor="middle", bg=False)
s.arrow([(C2 + W, 186), (C3, 186)], "red")
s.label(805, 202, "fails: rollback, AP kept", anchor="middle", bg=False)
# Starting -> Running
s.arrow([(600, R1 + H), (600, R2)], "gray")
s.label(610, 258, ["task RUNNING,", "registry PutItem"], bg=False)
# Running <-> Idle-warned
s.arrow([(C2 + W, 352), (C3, 352)], "purple", dashed=True)
s.label(805, 344, "idle scan: 0 requests", anchor="middle", bg=False)
s.arrow([(C3, 386), (C2 + W, 386)], "purple", dashed=True)
s.label(805, 402, "requests seen: clear", anchor="middle", bg=False)
# Running -> Orphaned
s.arrow([(C2, 370), (190, 370), (190, R3)], "purple", dashed=True)
s.label(200, 452, ["task stops outside pod-down", "(crash, manual stop-task)"], bg=False)
# Orphaned -> Stopping
s.arrow([(C1 + W, 566), (520, 566), (520, R4)], "purple", dashed=True)
s.label(310, 540, ["ECS STOPPED event:", "reaper invokes down"], bg=False)
# Running -> Stopping (pod-down)
s.arrow([(600, R2 + H), (600, R4)], "blue")
s.label(608, 640, ["pod-down", "workflow"], bg=False)
# Idle-warned -> Stopping
s.arrow([(1010, R2 + H), (1010, 470), (690, 470), (690, R4)], "purple", dashed=True)
s.label(850, 462, "still idle next scan: down", anchor="middle", bg=False)
# Stopping -> No pod (keep_workspace=false)
s.arrow([(C2, 766), (40, 766), (40, 168), (C1, 168)], "gray")
s.label(56, 758, "[keepWorkspace=false] AP deleted", bg=False)
# Stopping -> Retained (keepWorkspace=true: default, reaper)
s.arrow([(C2 + W, 766), (1160, 766), (1160, 168), (C3 + W, 168)], "gray")
s.label(726, 758, "[keepWorkspace=true] AP kept", bg=False)

# -- states ------------------------------------------------------------------
s.node(C1, R1, W, H, "No pod", ["no registry row", "no access point"], **STEADY)
s.node(C2, R1, W, H, "Starting", ["AP, task def, TG + rule, task", "pending; no registry row yet"], **TRANS)
s.node(C3, R1, W, H, "Workspace retained", ["no registry row", "access point kept (Pod tag)"], **STEADY)
s.node(C2, R2, W, H, "Running", ["registry row, task RUNNING", "pod-up again: conflict"], **LIVE)
s.node(C3, R2, W, H, "Idle-warned", ["row.idleSince set, SNS sent", "browser pods only"], **WARN)
s.node(C1, R3, W, H, "Orphaned", ["registry row present", "task STOPPED"], **TRANS)
s.node(C2, R4, W, H, "Stopping", ["pod-manager down:", "task, rule, TG, row removed"], **TRANS)

s.legend(40, 860, [
    ("arrow", "blue", "workflow-triggered"),
    ("dashed", "purple", "automatic (reaper / ECS)"),
    ("arrow", "red", "pod-up failure rollback"),
    ("arrow", "gray", "action completes"),
    ("dashedbox", ("#f8fafc", "#64748b"), "transient state"),
], gap=26)

s.write(OUT)
print(f"wrote {OUT}")
