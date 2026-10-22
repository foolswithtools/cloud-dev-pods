# Microsoft Entra ID for browser pods

Use this guide when your organization signs in with Microsoft 365 / Entra ID and you want browser pods to use those accounts instead of GitHub. It replaces the [GitHub OAuth App step](setup-cli.md#browser-mode-only-register-the-oauth-app) of the CLI walkthrough; every other step stays the same.

The `oauth2-proxy` sidecar in front of each browser pod uses its native [`entra-id` provider](https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/ms_entra_id). Tunnel pods are not affected; to log tunnels in with a Microsoft account, see [delivery modes](delivery-modes.md#tunnel-account-github-or-microsoft).

## Before you start

- **A domain you control, with `domain.strategy: byo`.** Entra ID only accepts `https` redirect URIs (apart from `localhost`), and the `alb-default` strategy serves pods over plain HTTP. Synth refuses `provider: entra-id` without `byo`.
- **Permission to register applications** in your Entra tenant (the default for members in most tenants), or an administrator who will do it for you. Group claims, "assignment required", and admin consent need an administrator role such as Application Administrator.
- **One redirect URI per pod.** `oauth2-proxy` builds its callback from the pod's hostname, so each pod has its own `https://<pod>.<base-domain>/oauth2/callback`, and each one must be registered on the app by hand. See [The redirect URI ceiling](#the-redirect-uri-ceiling).

## 1. Register the application

In the Microsoft Entra admin center, open **Identity > Applications > App registrations > New registration** ([Microsoft's guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)):

1. **Name**: anything you'll recognize, for example `cloud-dev-pods`.
2. **Supported account types**: **Accounts in this organizational directory only (single tenant)**. This is the right choice for almost everyone. See [Multi-tenant apps](#multi-tenant-apps) for the alternatives.
3. **Redirect URI**: platform **Web**, value `https://<pod>.<base-domain>/oauth2/callback` for your first pod (for example `https://hello.pods.example.com/oauth2/callback`).
4. Select **Register**.

From the app's **Overview** page, note:

- **Application (client) ID**: goes into `/cloud-dev-pods/oauth/client-id`.
- **Directory (tenant) ID**: goes into `auth.browser.issuerUrl`.

## 2. Create a client secret

Open **Certificates & secrets > Client secrets > New client secret** ([Microsoft's guide](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)). Pick an expiry, then copy the secret's **Value** right away (it is shown once). The **Secret ID** next to it is not the secret.

Entra client secrets expire (at most 24 months). Put a reminder in your calendar; when the secret expires, sign-ins fail until you create a new one and update `/cloud-dev-pods/oauth/client-secret`.

## 3. Add a groups claim (only if you use `allowedGroups`)

`auth.browser.allowedGroups` matches the group object IDs in the ID token's `groups` claim, which Entra leaves out unless you ask for it:

1. Open **Token configuration > Add groups claim**.
2. Select **Security groups** (or the group types you use).
3. Under **ID**, keep **Group ID**.
4. Select **Add**.

Find a group's object ID under **Identity > Groups > All groups > (your group) > Object ID**.

**More than 200 groups.** When a user belongs to more than 200 groups, Entra drops the `groups` claim from the token ("group overage"). Set `auth.browser.entraGroupOverage: true` so `oauth2-proxy` requests the `User.Read` scope and reads the user's groups from Microsoft Graph instead. Without it, those users sign in with no groups and get a 403. Users consent to `User.Read` on their first sign-in unless an administrator grants consent for the tenant under **API permissions > Grant admin consent**. See Microsoft's [group overage notes](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles).

## 4. Optional: require assignment

Instead of (or as well as) `allowedGroups`, Entra can refuse everyone who has not been assigned to the app before they ever reach the pod ([Microsoft's guide](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users)):

1. Open **Identity > Applications > Enterprise applications > (your app) > Properties**.
2. Set **Assignment required?** to **Yes** and save.
3. Under **Users and groups > Add user/group**, assign the people or groups who may use pods.

Unassigned users see an Entra error (`AADSTS50105`) instead of a pod. Assignment is configured in Entra, so cloud-dev-pods cannot see it: the [browser restriction guard](troubleshooting.md#browser-pod-up-fails-with-refusing-browser-mode-pod-up-authbrowserprovider--has-no-sign-in-restriction) still needs one of the `auth.browser` restrictions below. With a single-tenant app, `allowedTenants: [<your tenant ID>]` is the natural choice.

## 5. Configure `config/config.yaml`

```yaml
domain:
  strategy: byo
  baseDomain: pods.example.com
  hostedZoneId: Z0123456789ABCDEFGHIJ

auth:
  browser:
    provider: entra-id
    issuerUrl: https://login.microsoftonline.com/<directory-tenant-id>/v2.0
    allowedTenants: [<directory-tenant-id>]   # whole tenant; or use allowedGroups
    allowedGroups: []                         # group object IDs
    allowedEmailDomains: []                   # e.g. [example.com]
    entraGroupOverage: false                  # true: users in > 200 groups
```

| Key | What it does | `oauth2-proxy` setting |
| --- | --- | --- |
| `issuerUrl` | Required. `https://login.microsoftonline.com/<tenant-id>/v2.0` with the tenant ID as a GUID. | `OAUTH2_PROXY_OIDC_ISSUER_URL` |
| `allowedTenants` | Tenant IDs whose users may sign in. Required with a multi-tenant issuer. | `OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS` |
| `allowedGroups` | Group object IDs; a user must be in at least one. | `OAUTH2_PROXY_ALLOWED_GROUPS` |
| `allowedEmailDomains` | Email domains to admit; empty means any. | `OAUTH2_PROXY_EMAIL_DOMAINS` |
| `entraGroupOverage` | Adds `User.Read` to the scope `openid email profile`. | `OAUTH2_PROXY_SCOPE` |
| `ownerOnly`, `adminUsers` | Per-pod owner authorization by email; see [operating](operating.md#per-pod-owner-authorization). | `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` |

The restrictions combine: a user must pass every one that is set (tenant **and** group **and** email domain, and with `ownerOnly`, be the owner or an admin). A browser `pod-up` is refused unless at least one of `allowedTenants`, `allowedGroups`, `allowedEmailDomains`, or `ownerOnly: true` is set. If `allowedTenants` includes the personal Microsoft account tenant (`9188040d-6c67-4c5b-b112-36a304b66dad`), it does not count as a restriction, because anyone can create a personal account; add `allowedGroups`, `allowedEmailDomains`, or `ownerOnly` as well.

`allowedEmailDomains` and `ownerOnly` match the token's `email` claim, which Entra only fills in for users with a mailbox (the `mail` attribute). Users without one cannot sign in at all; see [troubleshooting](troubleshooting.md#entra-id-sign-in-fails-with-neither-the-id_token-nor-the-profileurl-set-an-email).

`auth.browser.allowedOrg` and `auth.browser.allowedUsers` are GitHub-only and fail validation with `entra-id`. The deprecated `github.oauthAllowedOrg` / `github.oauthAllowedUsers` keys are ignored once `auth.browser` is set; remove them.

Commit and push the config.

## 6. Store the client ID and secret

The client ID and secret use the same Secrets Manager paths as GitHub (`bootstrap-aws.yml` creates them):

```bash
aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-id \
  --secret-string "<Application (client) ID>"
aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-secret \
  --secret-string "<client secret Value>"
```

Leave `/cloud-dev-pods/oauth/cookie-secret` alone.

## 7. Deploy and start a pod

`cluster-up` redeploys the pod-manager Lambda with the new `auth.browser` settings:

```bash
gh workflow run cluster-up.yml && gh run watch
gh workflow run pod-up.yml -f pod_name=hello -f mode=browser && gh run watch
```

The `pod-up` summary prints the pod URL and the exact **OAuth redirect URI** for that pod. If it is not registered yet, add it under **Authentication > Platform configurations > Web > Redirect URIs** before you open the pod. Then open the URL, sign in with your Entra account, and you land in VS Code. A user who signs in but fails a restriction (for example, is in the tenant but not in an allowed group) gets an `oauth2-proxy` 403 page.

Switching an existing deployment from GitHub: running pods keep their old sidecar settings. Stop and start them (`pod-down`, then `pod-up`) after `cluster-up`, and register each pod's redirect URI.

## The redirect URI ceiling

Every browser pod needs its own redirect URI on the app registration. Entra caps this at **256 redirect URIs** per app for work or school accounts, and **100** for apps that also sign in personal Microsoft accounts. Each URI may be at most 256 characters, and the limit cannot be raised ([Microsoft's limits](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)). Remove the URIs of pods you no longer use.

Entra also accepts wildcard redirect URIs for work-or-school-only apps, but only through the application manifest, and Microsoft advises against them. cloud-dev-pods does not test or rely on them.

A single shared callback URL for all pods is tracked in [#144](https://github.com/foolswithtools/cloud-dev-pods/issues/144). Registering redirect URIs automatically through Microsoft Graph is deferred (spec item A6).

## Multi-tenant apps

If users from more than one Entra tenant need access, register the app with **Accounts in any organizational directory (multitenant)** and use the matching issuer:

| Supported account types | `issuerUrl` tenant segment |
| --- | --- |
| Single tenant | `<tenant-id>` (GUID) |
| Any organizational directory | `organizations` |
| Any organizational directory and personal Microsoft accounts | `common` |
| Personal Microsoft accounts only | `consumers` |

**Owner-only across tenants.** `ownerOnly` matches the `email` claim, and in Entra the administrators of each tenant control their users' mail addresses. With several tenants in `allowedTenants`, an administrator of any of them could give an account another tenant's owner address and open that owner's pod. Only list tenants whose administrators you trust, or combine `ownerOnly` with `allowedGroups`.

With `common`, `organizations`, or `consumers`, `auth.browser.allowedTenants` is required: without it, any Microsoft tenant's users could sign in. For these issuers the sidecar sets `OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION=true`, because their discovery documents report a tenant-specific issuer; the `entra-id` provider still checks that each token comes from a `login.microsoftonline.com/<tenant>/v2.0` issuer and from an allowed tenant.

Sovereign clouds (for example `login.microsoftonline.us`) are not supported.
