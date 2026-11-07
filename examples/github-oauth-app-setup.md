# Setting up the GitHub OAuth App for ALB authentication

cloud-dev-pods uses oauth2-proxy with a GitHub OAuth App to authenticate users before they reach a pod's openvscode-server.

## Create the app

1. Go to https://github.com/settings/applications/new (personal) or your org's OAuth Apps page (`https://github.com/organizations/<ORG>/settings/applications`).
2. Fields:
   - **Application name**: `cloud-dev-pods` (or whatever you want).
   - **Homepage URL**: `https://github.com/<your>/cloud-dev-pods`.
   - **Authorization callback URL**: `https://<pod-name>.<your-base-domain>/oauth2/callback`, for example `https://hello.pods.example.com/oauth2/callback`. GitHub OAuth Apps don't accept wildcard subdomains and take exactly one callback URL, so the app serves one pod hostname. Pick the pod name now and use it with `pod-up`. For more pods, see "OAuth App won't accept callback URL with wildcard" in `docs/troubleshooting.md`.
3. Save. GitHub gives you a Client ID. Generate a Client Secret.

## Wire it into the repo

1. Store the credentials in AWS Secrets Manager. `bootstrap-aws.yml` creates both secrets with placeholder values; overwrite them:

   ```bash
   aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-id \
     --secret-string "<client-id>"
   aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-secret \
     --secret-string "<client-secret>"
   ```

   Leave `/cloud-dev-pods/oauth/cookie-secret` alone; bootstrap generated it.

2. Set who may sign in, in `config/config.yaml`. Set `auth.browser.allowedOrg` for a team, or `auth.browser.allowedUsers` for a solo setup:

   ```yaml
   auth:
     browser:
       allowedOrg: <your-github-org>
       # OR allowedUsers: [<your-github-login>]
   ```

## Per-repo vs per-org

- **Per-repo** (default for solo devs): the OAuth App is owned by your user account, restricts pod access to a single GitHub user (`OAUTH2_PROXY_GITHUB_USERS`).
- **Per-org**: the OAuth App is owned by your org, restricts pod access to org members (`OAUTH2_PROXY_GITHUB_ORG`).

Per-org requires org admin to create/install the app. Per-repo is the simpler default.

## Verify

After `pod-up`, visit the URL. You should be redirected to GitHub, asked to authorize the app, then land in VS Code.
