# ADR 0009: Per-request owner check for the central auth host

## Status

Proposed (2026-11-01). Builds on [ADR 0002](0002-oauth2-proxy-sidecar.md) (oauth2-proxy sidecar) and [ADR 0008](0008-pluggable-browser-idp.md) (pluggable browser identity provider). Decides [#174](https://github.com/foolswithtools/cloud-dev-pods/issues/174) and gates the central auth host build, [#144](https://github.com/foolswithtools/cloud-dev-pods/issues/144).

Every oauth2-proxy citation below is `path:line` in the oauth2-proxy source at tag [`v7.15.5`](https://github.com/oauth2-proxy/oauth2-proxy/tree/v7.15.5), the version this repo pins (`infra/lambda/pod-manager/oauth2-proxy.ts:12`). Citations of this repo are marked "repo".

## Context

[Spec A5](../specs/pluggable-identity-remote-access.md#a5) adds an optional `auth.browser.centralAuthHost`: one always-on oauth2-proxy at `auth.<base>` that completes every OAuth callback and sets one session cookie on the parent domain (`.<base>`). Every pod's sidecar then accepts that cookie, so a single registered callback URL serves every pod.

Accepting one cookie in every pod means every sidecar must share one cookie secret. That removes the protection owner-only ([#164](https://github.com/foolswithtools/cloud-dev-pods/issues/164)) relies on today. Owner-only gives each task its own random cookie secret, so a cookie issued by pod A is not a session on pod B (repo `infra/lambda/pod-manager/owner-authz.ts:15-19`, code at `:156`, `:185`, `:188`).

With a shared cookie, the owner check has to run **on every request** in each pod's sidecar. Today that holds only for some providers:

- `entra-id` / `oidc`: owner-only writes an authenticated-emails file and removes `EMAIL_DOMAINS` (repo `owner-authz.ts:168-177`). The emails file is checked on every request (Q1 below).
- `github`: owner-only sets `OAUTH2_PROXY_GITHUB_USERS` (repo `owner-authz.ts:163`). That check runs only during the OAuth callback (`providers/github.go:133-148`, `:407-451`). With a central host the callback runs on `auth.<base>`, never on the pod sidecar, so a github pod sidecar would admit anyone the central host admitted.

Issue #174 offered three options:

1. **GitHub owner by verified email.** For `github` with `centralAuthHost`, the owner is identified by their verified primary email, checked by the same per-request emails file as `entra-id` / `oidc`.
2. **Central host only for `entra-id` / `oidc`.** Refuse `centralAuthHost` with `github` at synth time.
3. **A separate per-request authorizer** that compares the signed-in user to the pod's `Owner` tag, in one of three forms: (a) an authorizer container between the sidecar and VS Code, (b) an ALB `authenticate-oidc` action, (c) a Lambda target in the data path.

## Decision

**Option 1, for every provider.** With `centralAuthHost: true`, each pod sidecar enforces the owner on every request through `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE`, with `OAUTH2_PROXY_EMAIL_DOMAINS` removed. For `github` the owner and `adminUsers` become email addresses: the GitHub account's verified primary email.

| Provider | Choice | Per-request check on the pod sidecar |
| --- | --- | --- |
| `github` | Option 1 | Emails file, owner and admins as verified primary emails. `EMAIL_DOMAINS` removed. `ALLOWED_GROUPS=<allowedOrg>` kept when an org is set. |
| `entra-id` | Option 1 (already today's owner-only mechanism) | Emails file. `EMAIL_DOMAINS` removed. `ALLOWED_GROUPS` kept when set. |
| `oidc` | Option 1 (already today's owner-only mechanism), once [#180](https://github.com/foolswithtools/cloud-dev-pods/issues/180) wires `provider: oidc` | Emails file. `EMAIL_DOMAINS` removed. `ALLOWED_GROUPS` kept when set. |

Option 2 stays the fallback. It is not needed, because Q1 and Q3 below both came back positive.

### Why the emails file works for every provider

The emails check is not provider code. `main.go:70` builds one validator from `EmailDomains` and `AuthenticatedEmailsFile`. `Proxy` (`oauthproxy.go:1063-1064`) calls `getAuthenticatedSession`, which runs that validator on the session email on every proxied request (`oauthproxy.go:1176`). When the validator fails, the request is refused (`oauthproxy.go:1182-1195`, then 403 at `:1096-1100`). The validator only reads the session's `Email` field, so it behaves the same for `github`, `entra-id` and `oidc`.

### The github sidecar must drop `EMAIL_DOMAINS=*`

This is the single most important implementation detail. Today's github sidecar sets `OAUTH2_PROXY_EMAIL_DOMAINS=*` (repo `oauth2-proxy.ts:43`), and the owner-only github branch keeps it (repo `owner-authz.ts:158-166`). In the validator, a `*` domain sets `allowAll` (`validator.go:81-84`), and `allowAll` forces every non-empty email to be valid regardless of the emails file (`validator.go:98-100`). So the github branch must remove `OAUTH2_PROXY_EMAIL_DOMAINS`, as the `entra-id` / `oidc` branch already does (repo `owner-authz.ts:174`). oauth2-proxy still starts without it, because an emails file satisfies its startup check (`pkg/validation/options.go:51-53`).

### Keep `ALLOWED_GROUPS`, drop `GITHUB_ORG` / `GITHUB_USERS` on central-host github sidecars

- `ALLOWED_GROUPS` is checked on every request through `provider.Authorize` (`oauthproxy.go:1177`, `providers/provider_default.go:125-137`). The github provider puts org logins in session groups (`providers/github.go:506`), so `ALLOWED_GROUPS=<allowedOrg>` keeps the org requirement per request, as owner-only does today (repo `owner-authz.ts:164`).
- `GITHUB_ORG` and `GITHUB_USERS` are read only by `EnrichSession` → `checkRestrictions` (`providers/github.go:139-141`, `:407-451`). That is the callback path (`oauthproxy.go:955`), which a pod sidecar does not serve once its redirect URL is `auth.<base>`. Leaving them set would suggest a per-request check that does not exist, so the central-host github sidecar omits both.

### Owner-as-email applies only with `centralAuthHost: true`

Without a central host, github owner-only keeps today's design: the owner is a login in `GITHUB_USERS`, and the per-task cookie secret stops replay across pods. It is sound, and switching it to emails would change the meaning of `pod-up -f owner=` and of `adminUsers` for every existing github owner-only deployment, for no security gain. The "one code path for all providers" benefit is real in central-host mode, and that is where it applies.

### Shared cookie secret only with `ownerOnly: true`

A shared cookie secret across pods is acceptable **only** when `auth.browser.ownerOnly: true`. Without owner-only, no sidecar runs a per-request owner check, and one cookie would open every pod for anyone the deployment allowlist admits. Today's default deployment already behaves that way (every pod shares `/cloud-dev-pods/oauth/cookie-secret`, repo `owner-authz.ts:15-16`), but central-host mode exists to serve owner-only deployments. #144's synth guard enforces this: `centralAuthHost: true` fails synth unless `ownerOnly: true` and `domain.strategy: byo`.

### Central host: allowlist and secrets (Q4)

The proposed default from #174 is confirmed:

- The `auth.<base>` oauth2-proxy uses the existing shared `/cloud-dev-pods/oauth/{client-id,client-secret,cookie-secret}` secrets. The single OAuth app's callback becomes `https://auth.<base>/oauth2/callback`.
- It enforces the deployment-wide allowlist: the provider settings `buildOauth2ProxyContainer` emits with `ownerOnly` off (repo `oauth2-proxy.ts:34-73`). A user outside the deployment never gets a cookie. Owner checks stay in each pod sidecar.

### Verdicts on the other options

- **Option 2 (refuse `github`):** viable but not chosen. It adds no new trust surface, but the default provider would get no single-callback benefit. It is the fallback if a future oauth2-proxy version stops filling the github session email from the verified primary address (today: `providers/github.go:357-362`).
- **Option 3a (authorizer container):** viable, not chosen. oauth2-proxy sends `X-Forwarded-User` and `X-Forwarded-Email` upstream by default: `pass_user_headers` defaults to `true` (`pkg/apis/options/legacy_options.go:44`, flag default at `:217`), mapped to the `user` and `email` session claims (`legacy_options.go:309-364`). Each header has `PreserveRequestValue: false` (`legacy_options.go:313`, `:328`, `:343`, `:354`), so a value sent by the client is overwritten and an authorizer can trust it. For github, `user` is the login (`providers/github.go:394`), so 3a is the one option that keeps github owners as logins. It loses to option 1 on cost, not correctness: an extra container per pod, an extra hop, and the authorizer has to proxy VS Code's websocket.
- **Option 3b (ALB `authenticate-oidc`):** not viable here. It is deferred item A7 in [#151](https://github.com/foolswithtools/cloud-dev-pods/issues/151). It cannot serve `github` at all, because GitHub OAuth Apps are not an OIDC provider. The listener action authenticates but has no per-pod owner comparison, so it would still need a per-pod check.
- **Option 3c (Lambda target in the data path):** not viable. It puts a Lambda invocation on every request, and ALB Lambda targets reject websocket upgrades with HTTP 400 ([AWS: Lambda functions as targets](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html), "Limits"). VS Code needs websockets (oauth2-proxy proxies them by default, `legacy_options.go:36`, `:120`).

## Answers to the questions in #174

### Q1. Is `--authenticated-emails-file` enforced on every request for `github`?

**Yes, on every request, for every provider, outside the provider's session-validation hook.**

- The validator comes from `EmailDomains` plus `AuthenticatedEmailsFile` (`main.go:70`, `validator.go:76-109`). Emails-file entries and the session email are both lowercased before comparing (`validator.go:70`, `:93`).
- It runs at login, before the cookie is saved (`oauthproxy.go:986`). It runs again on every proxied request (`oauthproxy.go:1063-1064` → `:1176`). A failure clears the session and returns 403 (`oauthproxy.go:1182-1195`, `:1096-1100`).
- It is not part of the provider's `ValidateSession`. The stored-session loader calls `ValidateSession` (`pkg/middleware/stored_session.go:288-298`) only when a session is refreshed (`stored_session.go:155-159`, `:244-246`). Refresh is off by default (`cookie_refresh` = 0, `pkg/apis/options/cookie.go:39`). The github `ValidateSession` only checks that the access token is still valid (`providers/github.go:151-153`).
- Caveat: the per-request check skips sessions with an empty email (`oauthproxy.go:1176`, `session.Email != "" && ...`). The login check refuses an empty email (`validator.go:90-91`), so every cookie the central host mints carries one. Sessions from other loaders could skip it, namely htpasswd basic auth (`oauthproxy.go:428-430`) and JWT bearer tokens (`oauthproxy.go:414-426`, which can set the email to the user, `providers/oidc.go:224-227`). Both are off by default (`skip_jwt_bearer_tokens`, `pkg/apis/options/options.go:134`). Sidecars must keep them off.
- Second caveat: requests that oauth2-proxy treats as allowed skip every check. `getAuthenticatedSession` returns before the validator runs when `IsAllowedRequest` is true (`oauthproxy.go:1168-1170`). That covers `skip_auth_preflight` OPTIONS requests, `skip_auth_routes` / `skip_auth_regex` matches and `trusted_ips` sources (`oauthproxy.go:589-591`). `Proxy` then forwards the request to VS Code (`oauthproxy.go:1063-1076`). The repo sets none of these today. Central-host sidecars must keep all of them unset.

### Q2. Does the github provider's default scope include `user:email`?

**Yes.** `githubDefaultScope = "user:email read:org"` (`providers/github.go:35`), applied in `NewGitHubProvider` (`providers/github.go:75`) whenever no scope is configured (`providers/provider_data.go:221-223`). The repo sets no `OAUTH2_PROXY_SCOPE` for github (repo `oauth2-proxy.ts:35-47`), so the default applies. Option 1 needs no scope change, and the "may need the `user:email` scope" premise in #174 drops out.

### Q3. Is the session email always the verified primary email?

**Yes.** `EnrichSession` calls `getEmail` (`providers/github.go:143`). `getEmail` reads `/user/emails` and sets `s.Email` only for an entry that is both `Verified` and `Primary` (`providers/github.go:338-366`, assignment at `:357-362`). With no verified primary email it leaves the email empty, and login is refused (`validator.go:90-91`, `oauthproxy.go:986`).

No other github path writes the session email:

- `getUser` unmarshals the public-profile `email` but assigns only `s.User = user.Login` (`providers/github.go:370-395`, `:394`).
- `hasUser` also unmarshals `email` but takes no session and returns only a bool (`providers/github.go:290-313`).
- The token redeem the github provider inherits returns a session with only the access token (`providers/provider_default.go:51-108`, `:89-91`).
- `enrichSessionState` calls `GetEmailAddress` first only when the email is empty. For github that is the default `ErrNotImplemented` stub (`oauthproxy.go:1024-1036`, `providers/provider_default.go:113-115`).

### Q4. Which allowlist and secrets does `auth.<base>` use?

**The proposed default is confirmed** (see "Central host: allowlist and secrets" above), with the citations that make it work:

- **Login gate.** For github, `GITHUB_ORG` / `GITHUB_USERS` are enforced in `checkRestrictions` (`providers/github.go:407-451`). A listed user skips the org check (`providers/github.go:408-411`). For `entra-id` / `oidc` the gate is `EMAIL_DOMAINS` (`validator.go:94`), `ALLOWED_GROUPS` (`providers/provider_default.go:125-137`) and, for multi-tenant Entra, `ALLOWED_TENANTS` (`providers/ms_entra_id.go:83-100`, called at login, `oauthproxy.go:971`). All of these run in `OAuthCallback` before the cookie is saved (`oauthproxy.go:955-998`).
- **Cookie secret.** The pod sidecar sets the CSRF cookie when it starts the flow, and the central host must decode it in `OAuthCallback` (`oauthproxy.go:936-946`). So the shared secret, and the same cookie name, covers both the CSRF cookie and the session cookie.
- **Redirect back to the pod.** The central host must set `whitelist_domains=.<base>` (`pkg/apis/options/options.go:142`). Otherwise the post-login redirect to the pod's URL is replaced with `/` (`oauthproxy.go:977-979`).
- **Who can read the shared secret.** It is granted to execution roles only, never task roles: today the pod task execution role (repo `infra/lib/stacks/pod-task-family-stack.ts:80-82`). The browser task role has only log permissions (repo `pod-task-family-stack.ts:86-96`). The central host's own Fargate service will need its own execution-role grant. That rule must stay true: anyone holding the cookie secret can mint a session with any email.

### Q5. Reserved pod name `auth`

**Confirmed.** Pod names match `^[a-z0-9-]{1,30}$` (repo `infra/lambda/pod-manager/handler.ts:10`, `:24`, `:30`), so a pod named `auth` would claim `auth.<base>`. #144 reserves it **unconditionally**, whether or not `centralAuthHost` is on, so turning the central host on later can never collide with an existing pod. Only `up` is refused (`invalid-input`). `down` and `status` keep accepting `auth`, so a pre-existing pod with that name can still be inspected and torn down.

## Consequences

- One OAuth callback URL serves every browser pod when `centralAuthHost` is on, for all three providers. CLAUDE.md rule 6 and step 3d can drop the "pick the pod name now" constraint in that mode ([#143](https://github.com/foolswithtools/cloud-dev-pods/issues/143)).
- For github in central-host mode, `pod-up -f owner=` and `auth.browser.adminUsers` take email addresses: the account's verified primary email on GitHub. If the owner changes their GitHub primary email, they lose access until the pod is recreated with the new owner. A GitHub account with no verified primary email cannot sign in at all, which is also true today (`validator.go:90-91`).
- **A 403 on another owner's pod signs the user out of every pod.** When the per-request check fails, oauth2-proxy clears the session cookie (`oauthproxy.go:1188-1194`). With `cookie_domains=.<base>` that cookie is the shared one. The user then signs in again at `auth.<base>`. That is safe, but #144's human checklist and its docs should expect "403, then signed out everywhere", not only a 403.
- `adminUsers` lose their implicit pass through the deployment allowlist. Today, owner-only replaces the sidecar allowlist with the owner and admins. With a central host, admins still have to pass the deployment-wide allowlist at `auth.<base>`: for github, be in `allowedUsers` or `allowedOrg` at login, and also be an org member whenever `allowedOrg` is set, because the sidecar keeps `ALLOWED_GROUPS=<allowedOrg>` per request (the same AND rule as owner-only today, repo `owner-authz.ts:10-11`). For `entra-id` / `oidc`, admins must match `allowedEmailDomains`. The emails file only narrows who gets in on top of that.
- Pod-up loses one early error for github. `validateOwnerAuthorization` can no longer check the owner against `allowedUsers` (logins vs an email). Access control does not depend on that check, because the central host enforces the allowlist at login. A typo now shows up as a 403 instead of a refused pod-up.
- The shared cookie secret becomes a deployment-wide key: whoever holds it can forge a session for any pod. It must stay out of task roles and out of the vscode container.
- No new runtime component. The only new service is the central oauth2-proxy itself (spec A5, about $3-9/month).
- Option 3a stays available if a future need (for example, owner-by-login for github) outweighs its cost.

## Scope changes for #144

Apply these to #144's body. Where they conflict with it, this ADR wins.

1. **Synth guard.** Keep "`centralAuthHost: true` requires `ownerOnly: true` and `domain.strategy: byo`". No provider is refused. Name ADR 0009 in the error message.
2. **github sidecar under `centralAuthHost`** (`buildOwnerAuthorization`, repo `owner-authz.ts:158-166`). Use the emails-file path for `github` too:
   - add `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` and the `WRITE_EMAILS` init step, with owner and admins lowercased (as at repo `owner-authz.ts:171`)
   - remove `OAUTH2_PROXY_EMAIL_DOMAINS`, `OAUTH2_PROXY_GITHUB_ORG` and `OAUTH2_PROXY_GITHUB_USERS`
   - keep `OAUTH2_PROXY_ALLOWED_GROUPS=<allowedOrg>` when an org is set

   Without `centralAuthHost`, github owner-only is unchanged.
3. **Owner validation for github under `centralAuthHost`** (`validateOwnerAuthorization`):
   - `identityKind` (repo `owner-authz.ts:65-69`) returns the `EMAIL` regex (repo `:63`) for github when `centralAuthHost` is on, instead of `GITHUB_LOGIN` (repo `:60`). `adminUsers` entries are validated as emails too.
   - Skip the `allowedUsers` membership check (repo `owner-authz.ts:98-105`) in that mode, since it compares logins and the central host enforces `allowedUsers` at login. Do not apply the `allowedEmailDomains` check to github owners: the github central host never enforces that setting (it emits `EMAIL_DOMAINS=*`, repo `oauth2-proxy.ts:43`), so a pod-up-only check would make the config look stricter than it is.
   - Update the refusal messages and the `pod-up.yml` `owner` input description to say "verified primary GitHub email" in this mode.
   - The default owner fails closed: `pod-cli.ts` falls back to `GITHUB_ACTOR` (repo `scripts/pod-cli.ts:65`), which is a login. In central-host github mode every pod-up needs an explicit email `owner=`, and the refusal message should say so.
4. **Central host container.** Build it with `buildOauth2ProxyContainer` and `ownerOnly` off, using the three shared secrets. Add `OAUTH2_PROXY_REDIRECT_URL=https://auth.<base>/oauth2/callback`, `OAUTH2_PROXY_COOKIE_DOMAINS=.<base>` and `OAUTH2_PROXY_WHITELIST_DOMAINS=.<base>`. Keep the default cookie name on the central host and on every sidecar.
5. **Pod sidecars** keep the shared `OAUTH2_PROXY_COOKIE_SECRET` and skip the per-task secret file (the three bypass points already listed in #144). They must not set any of these, each of which lets a request past the per-request check (Q1 caveats):
   - `skip_jwt_bearer_tokens` or an htpasswd file (empty-email sessions)
   - `skip_auth_routes`, `skip_auth_regex`, `trusted_ips` or `skip_auth_preflight` (allowed requests skip all checks, `oauthproxy.go:1168-1170`)
6. **Tests** (`infra/test/owner-authz.test.ts`), for each of `github`, `entra-id` and `oidc` under `centralAuthHost`:
   - the sidecar has `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE`
   - no `OAUTH2_PROXY_EMAIL_DOMAINS` is set; for github, a test that fails if `EMAIL_DOMAINS=*` survives
   - no `OAUTH2_PROXY_GITHUB_USERS` / `GITHUB_ORG` for github
   - `OAUTH2_PROXY_COOKIE_SECRET` is present and no cookie-secret file is written or mounted
   - none of `OAUTH2_PROXY_SKIP_JWT_BEARER_TOKENS`, `OAUTH2_PROXY_HTPASSWD_FILE`, `OAUTH2_PROXY_SKIP_AUTH_ROUTES`, `OAUTH2_PROXY_SKIP_AUTH_REGEX`, `OAUTH2_PROXY_TRUSTED_IPS` or `OAUTH2_PROXY_SKIP_AUTH_PREFLIGHT` is set
   - `validateOwnerAuthorization` accepts an email and rejects a login for github in this mode
7. **Human checklist.** Change the cross-pod item to "receives HTTP 403 on pod B and is then signed out of pod A too (shared cookie cleared)".
8. **Docs.** `docs/choosing-auth-and-access.md` (via #143) states that github owners and admins are emails in central-host mode, and that admins must also pass the deployment-wide allowlist.
9. **Reserved name.** Unchanged from #144: refuse `up` for `podName: auth` unconditionally, and keep `down` / `status` accepting it.
10. **`oidc`.** Unchanged dependency: #180 must merge first, because the sidecar builder throws for `oidc` until then (repo `oauth2-proxy.ts:72`).
