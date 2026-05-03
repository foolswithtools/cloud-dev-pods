// Phase 7: thin wrapper over `lambda:Invoke` for the pod-manager Lambda.
// Used by both GitHub Actions workflows (pod-up, pod-down, pod-list) and
// developers running locally. Validates inputs and pretty-prints responses.
//
// Usage (target):
//   tsx scripts/pod-cli.ts up   --pod <name> --mode browser|tunnel [--cpu 1024] [--memory 2048]
//   tsx scripts/pod-cli.ts down --pod <name>
//   tsx scripts/pod-cli.ts list
//
// The Lambda holds all ECS/ALB/EFS write permissions; this CLI's role only has
// `lambda:InvokeFunction` on it.

export {};
