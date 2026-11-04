"""Generate ../secrets-and-trust.svg (architecture diagram, Style 1)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _svglib import Svg  # noqa: E402

svg = Svg(
    1240, 700,
    "OAuth secrets and runtime trust",
    "Who can assume which role, and who can read the /cloud-dev-pods/oauth/* secrets. Workflow-to-role mapping is out of scope here.",
)

# Columns: A 40-300, B 360-600, C 700-940, D 1010-1210. Rows at y 96, 270, 430, 590.
svg.node("oidc", 40, 96, 260, 80, "GitHub Actions OIDC",
         ["token.actions.githubusercontent.com", "sub: main branch or env prod"], tint="gray")
svg.node("deployer", 700, 96, 240, 80, "CloudDevPodsDeployerRole",
         ["PowerUser + iam:*, boundary", "bootstrap, cluster-up/down"], tint="blue")
svg.node("operator", 1010, 96, 200, 80, "Operator",
         ["aws CLI, after registering", "the OAuth app"], tint="gray")
svg.node("podops", 40, 270, 260, 80, "CloudDevPodsPodOpsRole",
         ["Invoke pod-manager, ECR push,", "logs:FilterLogEvents"], tint="blue")
svg.node("lambda", 360, 270, 240, 80, "pod-manager Lambda",
         ["DescribeSecret only:", "never reads secret values"], tint="purple")
svg.node("secrets", 700, 270, 240, 80, "Secrets Manager",
         ["/cloud-dev-pods/oauth/", "client-id, client-secret,", "cookie-secret (generated)"], tint="orange")
svg.node("exec", 1010, 270, 200, 80, "Task execution role",
         ["CloudDevPodsTaskExecutionRole", "grantRead on 3 secrets"], tint="green")
svg.node("taskroles", 40, 430, 260, 80, "Task roles (browser/tunnel/ssh)",
         ["EFS ClientMount + ClientWrite", "no secrets, no logs"], tint="gray")
svg.node("sidecar", 700, 430, 240, 80, "oauth2-proxy sidecar",
         ["CLIENT_ID, CLIENT_SECRET,", "COOKIE_SECRET as env"], tint="orange")
svg.node("init", 700, 590, 240, 74, "owner-authz-init",
         ["writes /authz/cookie-secret;", "shared cookie secret dropped"], tint="purple")

svg.edge("e-oidc-deployer", [(300, 136), (700, 136)], color="blue",
         label="AssumeRoleWithWebIdentity", label_at=(500, 128))
svg.edge("e-oidc-podops", [(170, 176), (170, 270)], color="blue",
         label="same trust policy", label_at=(178, 228), label_anchor="start")
svg.edge("e-deployer-secrets", [(820, 176), (820, 270)], color="blue",
         label="deploys bootstrap stack", label_at=(812, 228), label_anchor="end")
svg.edge("e-operator-secrets", [(1110, 176), (1110, 220), (900, 220), (900, 270)], color="green",
         label="update-secret client-id/secret", label_at=(1005, 212))
svg.edge("e-podops-lambda", [(300, 310), (360, 310)], color="blue", label="Invoke", label_at=(330, 302))
svg.edge("e-lambda-secrets", [(600, 310), (700, 310)], color="gray", dashed=True,
         label="DescribeSecret", label_at=(650, 302))
svg.edge("e-exec-secrets", [(1010, 310), (940, 310)], color="green", label="read", label_at=(975, 302))
svg.edge("e-lambda-taskroles", [(420, 350), (420, 470), (300, 470)], color="blue",
         label="iam:PassRole", label_at=(360, 462))
svg.edge("e-lambda-sidecar", [(540, 350), (540, 470), (700, 470)], color="gray", dashed=True,
         label="task def: secret ARNs", label_at=(620, 462))
svg.edge("e-exec-sidecar", [(1110, 350), (1110, 470), (940, 470)], color="green",
         label="injects at task start", label_at=(1025, 462))
svg.edge("e-init-sidecar", [(820, 590), (820, 510)], color="purple",
         label="ownerOnly: per-task secret", label_at=(828, 556), label_anchor="start")

svg.legend(48, 630, [
    ("blue", False, "trust / invoke"),
    ("green", False, "secret value"),
    ("gray", True, "ARN / metadata only"),
    ("purple", False, "owner-only"),
], gap=24)

svg.write(Path(__file__).parent.parent / "secrets-and-trust.svg")
