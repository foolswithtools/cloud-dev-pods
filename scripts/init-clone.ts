// Phase 12: interactive setup for downstream forks.
// Prompts (via @clack/prompts) for:
//   - AWS account ID + region
//   - GitHub org/repo (auto-detected from `git remote get-url origin`)
//   - Pod domain strategy (BYO Route53 / ALB default / configure later)
//   - GitHub OAuth App client ID + secret (for ALB auth via oauth2-proxy)
//   - Org allowlist for oauth2-proxy
//   - Default pod sizing (small/medium/large -> Fargate cpu/memory)
//   - Tunnel mode default
//
// Generates: infra/config.local.ts, infra/extensions.local.ts,
//            .upstream-sync.state, .envrc.
// Pushes via gh: variables (AWS_ROLE_ARN, AWS_REGION, ...) and
//                secrets (OAUTH_GITHUB_CLIENT_SECRET, OAUTH_COOKIE_SECRET) to env "prod".
// Idempotent: rerunning detects existing state and offers update mode.

export {};
