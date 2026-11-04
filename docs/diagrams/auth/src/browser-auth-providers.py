"""Generate ../browser-auth-providers.svg (flowchart, Style 1)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _svglib import Svg  # noqa: E402

svg = Svg(
    1240, 700,
    "Browser auth config: from config.yaml to the oauth2-proxy sidecar",
    "auth.browser.provider = github | entra-id | oidc. Checked at synth, again at pod-up, then rendered into each task definition.",
)

# Row A: config pipeline and the restriction guard.
svg.node("cfg", 40, 96, 250, 76, "config.yaml auth.browser",
         ["schema.ts: per-provider rules", "legacy github.oauthAllowed* mapped"], tint="blue")
svg.node("env", 340, 96, 270, 76, "auth-env.ts -> env.ts",
         ["AUTH_BROWSER_* Lambda env vars", "(PodManager stack, cluster-up)"], tint="blue")
svg.diamond("guard", 790, 134, 220, 108, "Restriction set?", "auth-guard.ts")
svg.node("refuse1", 960, 102, 240, 64, "Refuse pod-up", "no sign-in restriction", tint="red")

# Row B: owner-only validation.
svg.diamond("owner", 790, 306, 220, 108, "Owner usable?", "validateOwnerAuthorization")
svg.node("refuse2", 960, 274, 240, 64, "Refuse pod-up", "bad owner or adminUsers entry", tint="red")

# Row C: sidecar builder and the owner-only switch.
svg.node("sidecar", 630, 420, 320, 104, "oauth2-proxy sidecar env",
         ["github: GITHUB_ORG, GITHUB_USERS",
          "entra-id: ISSUER, TENANTS, GROUPS, DOMAINS",
          "oidc: ISSUER, SCOPE, GROUPS, DOMAINS"], tint="orange")
svg.diamond("only", 440, 472, 200, 104, "ownerOnly?", "buildBrowserAuthTaskParts")
svg.node("init", 40, 434, 240, 76, "owner-authz-init",
         ["writes /authz/cookie-secret", "+ emails.txt (entra-id, oidc)"], tint="purple")

# Row D: resulting task definitions.
svg.node("task-shared", 320, 590, 240, 80, "Task: vscode + oauth2-proxy",
         ["shared COOKIE_SECRET from", "Secrets Manager"], tint="green")
svg.node("task-owner", 40, 590, 240, 80, "Task: + init container",
         ["COOKIE_SECRET_FILE (per task)", "owner + adminUsers only"], tint="purple")

svg.edge("e-cfg-env", [(290, 134), (340, 134)], label="", color="blue")
svg.edge("e-env-guard", [(610, 134), (680, 134)], color="blue", label="pod-up", label_at=(645, 126))
svg.edge("e-guard-no", [(900, 134), (960, 134)], color="red", label="no", label_at=(930, 126))
svg.edge("e-guard-yes", [(790, 188), (790, 252)], color="blue", label="yes (browser)",
         label_at=(798, 224), label_anchor="start")
svg.edge("e-owner-no", [(900, 306), (960, 306)], color="red", label="no", label_at=(930, 298))
svg.edge("e-owner-yes", [(790, 360), (790, 420)], color="blue", label="yes (or ownerOnly off)",
         label_at=(798, 394), label_anchor="start")
svg.edge("e-sidecar-only", [(630, 472), (540, 472)], color="green", label="build",
         label_at=(585, 464))
svg.edge("e-only-no", [(440, 524), (440, 590)], color="green", label="false",
         label_at=(448, 560), label_anchor="start")
svg.edge("e-only-yes", [(340, 472), (280, 472)], color="purple", label="true", label_at=(310, 464))
svg.edge("e-init-task", [(160, 510), (160, 590)], color="purple", label="SUCCESS before sidecar",
         label_at=(168, 553), label_anchor="start")

svg.legend(620, 630, [
    ("blue", False, "config / checks"),
    ("red", False, "refusal"),
    ("green", False, "default build"),
    ("purple", False, "owner-only"),
], gap=26)

svg.write(Path(__file__).parent.parent / "browser-auth-providers.svg")
