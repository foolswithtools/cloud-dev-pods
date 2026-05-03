# Contributing

Thanks for considering a contribution.

## Where to start

- Issues labeled `good first issue` are scoped for newcomers.
- Larger changes: open an issue first to align on direction. Drive-by PRs that touch architecture or workflows will likely be asked for an issue first.

## Workflow

1. Fork this repo (this is a public template repo, so forking is the standard path).
2. Create a feature branch.
3. Make changes. Commit using [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`. Append `!` for breaking changes.
4. `npm run lint && npm run test && npm run synth` locally.
5. Push and open a PR against `main`.

## Local dev

```bash
node --version  # >= 20
npm ci
npm run lint
npm run test
npm run synth
```

## CI gates

PRs must pass:

- `lint` — actionlint, markdownlint, eslint, shellcheck, link-check.
- `build-and-test` — tsc, vitest.
- `cdk-synth` — cdk synth + cdk-nag.
- `scan` — gitleaks, trivy, osv-scanner.

## Conventional Commit examples

```
feat(pod-up): add idle-shutdown override flag

Closes #42
```

```
fix(cdk-nag): suppress AwsSolutions-EC23 with justification

The default ALB SG allows :443 from 0.0.0.0/0 — that's the whole point.
```

```
feat(infra)!: switch from path-based to host-based ALB routing

BREAKING CHANGE: existing users must re-deploy ClusterStack and update
their config to set domain.strategy = "byo" or "alb-default".
```

## Code review

- One approval from `@foolswithtools/maintainers` required.
- All conversations resolved.
- Branch up to date with `main`.
- Signed commits required.

## Code of conduct

By participating, you agree to abide by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Questions

Open a [Discussion](https://github.com/foolswithtools/cloud-dev-pods/discussions) or use the `setup-help` issue template.
