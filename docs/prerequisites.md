# Prerequisites

Before running `gh workflow run bootstrap-aws.yml`, ensure you have:

## AWS

- An AWS account you own or admin (the bootstrap workflow needs admin-level IAM creds for one run).
- A region picked (default `us-west-2`).
- (Recommended) A Route53 hosted zone you own that pods will live under (e.g., `pods.example.com`).

## GitHub

- A fork (or template-generated copy) of this repo in your personal account or org.
- Recommended: keep the fork **private**.
- A GitHub OAuth App created for ALB authentication. See [`examples/github-oauth-app-setup.md`](../examples/github-oauth-app-setup.md).

## Local CLIs

```bash
gh auth status                      # GitHub CLI authenticated
aws sts get-caller-identity         # AWS CLI authenticated to the target account
node --version                      # >= 20
```

## Once authenticated, you can either:

- Run `npm run init` and follow the prompts (recommended).
- Or follow [`setup-cli.md`](setup-cli.md) / [`setup-gui.md`](setup-gui.md) to configure manually.
