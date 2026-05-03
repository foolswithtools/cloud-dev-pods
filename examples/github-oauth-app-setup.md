# Setting up the GitHub OAuth App for ALB authentication

cloud-dev-pods uses oauth2-proxy with a GitHub OAuth App to authenticate users before they reach a pod's openvscode-server.

## Create the app

1. Go to https://github.com/settings/applications/new (personal) or your org's OAuth Apps page (`https://github.com/organizations/<ORG>/settings/applications`).
2. Fields:
   - **Application name**: `cloud-dev-pods` (or whatever you want).
   - **Homepage URL**: `https://github.com/<your>/cloud-dev-pods`.
   - **Authorization callback URL**: `https://*.<your-base-domain>/oauth2/callback`. (Wildcard subdomain — supported by GitHub OAuth.)
3. Save. GitHub gives you a Client ID. Generate a Client Secret.

## Wire it into the repo

Either via `npm run init` (it'll prompt you) or manually:

```bash
gh variable set OAUTH_GITHUB_CLIENT_ID --body "<client-id>"
gh secret set OAUTH_GITHUB_CLIENT_SECRET --env prod --body "<client-secret>"
gh variable set OAUTH_ALLOWED_ORG --body "<your-github-org>"
```

## Per-repo vs per-org

- **Per-repo** (default for solo devs): the OAuth App is owned by your user account, restricts pod access to a single GitHub user (`OAUTH2_PROXY_GITHUB_USER`).
- **Per-org**: the OAuth App is owned by your org, restricts pod access to org members (`OAUTH2_PROXY_GITHUB_ORG`).

Per-org requires org admin to create/install the app. Per-repo is the simpler default.

## Verify

After `pod-up`, visit the URL. You should be redirected to GitHub, asked to authorize the app, then land in VS Code.
