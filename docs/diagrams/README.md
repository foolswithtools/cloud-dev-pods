# Architecture and design diagrams

Diagrams of how cloud-dev-pods is built and how it behaves at run time. Each diagram has its own page that explains it, walks through it step by step, and cites the source file and line behind every box and arrow. The diagrams show what the code does today. Features that exist only in an ADR or spec are left out, or noted on the page.

New here? Read them in this order: [system context](system/system-context.md), [AWS deployment topology](infrastructure/aws-deployment-topology.md), [pod-up sequence](pod-lifecycle/pod-up-sequence.md), then [browser request path](auth/browser-request-path.md) or [tunnel device-code flow](auth/tunnel-device-code-flow.md), depending on your delivery mode.

For the prose overview, see [`../architecture.md`](../architecture.md). For the reasoning behind each design, see the ADRs in [`../adr/`](../adr/).

## Index

### System

| Diagram | Type | What it answers |
| --- | --- | --- |
| [System context](system/system-context.md) | C4 level 1 | Who and what talks to the platform: the fork owner, the GitHub fork, the AWS account, identity providers, the VS Code tunnel service, and the upstream template. |

### Infrastructure

| Diagram | Type | What it answers |
| --- | --- | --- |
| [AWS deployment topology](infrastructure/aws-deployment-topology.md) | Architecture | What `cluster-up` deploys (VPC, ALB, ECS, EFS, Lambdas, DynamoDB) and how the pieces connect at run time. |
| [CDK stack composition](infrastructure/cdk-stack-composition.md) | Architecture | How the CDK app builds its six stacks, which stack passes what to which, which workflow deploys each one, and where `extensions.local.ts` hooks in. |

### Pod lifecycle

| Diagram | Type | What it answers |
| --- | --- | --- |
| [pod-up sequence](pod-lifecycle/pod-up-sequence.md) | Sequence | Every call from dispatching `pod-up.yml` to a reachable pod, including rollback on failure. |
| [How a pod stops](pod-lifecycle/pod-down-and-idle-reaper.md) | Flowchart | The three stop paths (`pod-down`, idle reaper, ECS task-stopped event) and what each one cleans up. |
| [Pod lifecycle states](pod-lifecycle/pod-state-machine.md) | State machine | The states a pod moves through, derived from the registry, ECS and EFS, and the events that move it. |

### Auth and access

| Diagram | Type | What it answers |
| --- | --- | --- |
| [Browser request path](auth/browser-request-path.md) | Sequence | One browser request from DNS to VS Code, including the OAuth sign-in and the allowlist check. |
| [Browser auth config](auth/browser-auth-providers.md) | Flowchart | How `auth.browser` in `config.yaml` (GitHub, Entra ID, OIDC, `ownerOnly`) becomes the oauth2-proxy sidecar's settings, and when pod-up refuses. |
| [Tunnel device-code sign-in](auth/tunnel-device-code-flow.md) | Sequence | How a tunnel pod gets from `pod-up` to a VS Code Desktop session through the device-code flow. |
| [OAuth secrets and runtime trust](auth/secrets-and-trust.md) | Architecture | Where the OAuth secrets live and which roles can read them or pass them on. |

### Operations

| Diagram | Type | What it answers |
| --- | --- | --- |
| [Workflows and IAM roles](operations/workflows-and-iam-roles.md) | Architecture | Which workflow assumes which IAM role through GitHub OIDC, and what each role may touch (ADR 0003). |
| [First-run setup flow](operations/first-run-setup-flow.md) | Flowchart | The order of setup steps from a fresh fork to the first pod. |
| [cluster-down guards](operations/cluster-down-guards.md) | Flowchart | The checks `cluster-down.yml` runs before `cdk destroy`, in run order. |
| [Upstream sync](operations/upstream-sync.md) | Data flow | How `sync-upstream` applies the tracked, merged and user taxonomy and opens a PR. |

### Runtime and configuration

| Diagram | Type | What it answers |
| --- | --- | --- |
| [Browser pod task anatomy](runtime/pod-task-anatomy-browser.md) | Architecture | The containers, volumes, roles and AWS resources inside one browser-mode ECS task. |
| [Tunnel pod task anatomy](runtime/pod-task-anatomy-tunnel.md) | Architecture | The single container in a tunnel-mode ECS task and what it talks to. |
| [Runtime image build](runtime/runtime-image-build.md) | Flowchart | How `build-runtime.yml` builds, scans and pushes the images, and how pod-up resolves an image tag. |
| [Config pipeline](runtime/config-pipeline.md) | Data flow | How `config/config.yaml` is written, validated and read by CDK, the pod-manager Lambda and workflow helpers. |

## Layout

```text
docs/diagrams/
├── README.md              this index
├── regenerate.sh          rebuilds every SVG from its source
└── <area>/
    ├── <slug>.svg         the diagram (renders inline on GitHub)
    ├── <slug>.md          explanation, walkthrough, element-by-element sources
    └── src/
        ├── <slug>.json    spec for the fireworks-tech-graph template generator, or
        └── <slug>.py      hand-written generator (sequence, state-machine and decision diagrams)
```

All diagrams use the same visual style (fireworks-tech-graph Style 1, Flat Icon), so colours and arrow styles mean the same thing across pages. Each page's "How to read it" section explains its legend.

## Regenerating

The SVGs come from [fireworks-tech-graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph) 1.2.0. That tool isn't vendored here.

- **JSON specs** (`src/*.json`) are rendered by its `scripts/generate-from-template.py`. It needs a checkout of the tool.
- **Python generators** (`src/*.py`) need only the Python standard library. Each writes `../<slug>.svg` next to itself.

To change a diagram, edit its source, then rebuild everything and validate:

```bash
export FIREWORKS_TECH_GRAPH=/path/to/fireworks-tech-graph
pip install cairosvg   # the tool's validator renders through cairosvg
docs/diagrams/regenerate.sh           # rewrite the SVGs in place
docs/diagrams/regenerate.sh --check   # or: confirm the committed SVGs match their sources
```

The script runs the tool's `validate-svg.sh` on every output: XML and marker integrity, arrow and node collisions, layout geometry and renderability. The validator doesn't catch everything (overlapping labels, for example), so export a PNG and look at it before you commit. Update the page's Elements table in the same change, so its citations stay accurate.

When the code a diagram describes changes, update the diagram in the same PR. A stale diagram is worse than none.
