// Per-pod owner authorization for browser pods (spec F4, opt-in via
// auth.browser.ownerOnly). Pure: no env reads, no SDK calls. registerTaskDef
// in aws.ts calls buildBrowserAuthTaskParts; actions.ts calls
// validateOwnerAuthorization before creating any AWS resource.
//
// oauth2-proxy semantics this module relies on (v7.15.5 source):
// - github: GITHUB_USERS is ORed with GITHUB_ORG (a listed user skips the org
//   check), and GITHUB_USERS is only checked at login. ALLOWED_GROUPS is
//   checked at login and on every request, and the github provider puts the
//   user's org logins in the session groups. So owner-only uses GITHUB_USERS
//   and keeps allowedOrg as ALLOWED_GROUPS (an AND), never GITHUB_ORG.
// - oidc / entra-id: the authenticated-emails file is ORed with EMAIL_DOMAINS
//   ("*" admits everyone), so owner-only removes EMAIL_DOMAINS. The emails
//   check runs on every request.
// - Every pod shares /cloud-dev-pods/oauth/cookie-secret by default, so a
//   session cookie from one pod decrypts on another. Owner-only gives each
//   task its own random cookie secret (COOKIE_SECRET_FILE), so a cookie
//   replayed from another pod is not a session here. COOKIE_SECRET wins over
//   COOKIE_SECRET_FILE when both are set, so the shared secret is dropped.
// - Central auth host (#144, ADR 0009): every sidecar must accept the cookie
//   auth.<baseDomain> mints, so the shared secret stays and the per-task
//   secret file is skipped. The owner check then has to run on every
//   request, for every provider: the emails file with EMAIL_DOMAINS removed
//   (for github the owner is the account's verified primary email; "*"
//   would admit everyone). GITHUB_ORG / GITHUB_USERS stay at the
//   deployment-wide values as the gate on the sidecar's own callback.

import type { ContainerDefinition, KeyValuePair, MountPoint, Volume } from '@aws-sdk/client-ecs';
import {
  buildOauth2ProxyContainer,
  type Oauth2ProxyAuthConfig,
  type Oauth2ProxyOptions,
  type Oauth2ProxySecretArns,
} from './oauth2-proxy';
import { SIGN_IN_TEMPLATE } from './sign-in-template';

export const OWNER_AUTHZ_VOLUME = 'owner-authz';
export const OWNER_AUTHZ_INIT_CONTAINER = 'owner-authz-init';
export const OWNER_AUTHZ_DIR = '/authz';
export const OWNER_AUTHZ_EMAILS_PATH = `${OWNER_AUTHZ_DIR}/emails.txt`;
export const OWNER_AUTHZ_COOKIE_SECRET_PATH = `${OWNER_AUTHZ_DIR}/cookie-secret`;
// Central auth host only: holds sign_in.html (OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR).
export const OWNER_AUTHZ_TEMPLATES_DIR = `${OWNER_AUTHZ_DIR}/templates`;

// 16 random bytes as 32 hex characters, with no trailing newline:
// oauth2-proxy reads the file verbatim (no trimming), and 32 characters is a
// valid AES key length whether it base64-decodes (to 24 bytes) or not. A
// 64-character hex string would be rejected. od and head are in the runtime
// image (coreutils); openssl is not guaranteed.
const WRITE_COOKIE_SECRET =
  `s=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n') && [ \${#s} -eq 32 ] && printf '%s' "$s" > ${OWNER_AUTHZ_COOKIE_SECRET_PATH}`;
const WRITE_EMAILS = `printf '%s\\n' "$OWNER_AUTHZ_EMAILS" | tr ',' '\\n' > ${OWNER_AUTHZ_EMAILS_PATH}`;
// The template arrives through an env var, like the emails: printf '%s'
// copies it verbatim (no %, backslash or {{ }} interpretation).
const WRITE_SIGN_IN_TEMPLATE =
  `mkdir -p ${OWNER_AUTHZ_TEMPLATES_DIR} && printf '%s' "$OWNER_AUTHZ_SIGN_IN_TEMPLATE" > ${OWNER_AUTHZ_TEMPLATES_DIR}/sign_in.html`;

export interface OwnerAuthzConfig extends Oauth2ProxyAuthConfig {
  ownerOnly: boolean;
  adminUsers: readonly string[];
  // auth.browser.centralAuthHost (#144). Requires ownerOnly, no adminUsers
  // and baseDomain; buildBrowserAuthTaskParts throws otherwise.
  centralAuthHost?: boolean;
}

export interface OwnerAuthzOptions extends Oauth2ProxyOptions {
  // Image for the init container that writes the emails file. The
  // oauth2-proxy image is distroless (no shell), so registerTaskDef passes the
  // pod's own runtime image, which is already pulled for the task.
  initImage: string;
  // domain.baseDomain; read only when centralAuthHost is on.
  baseDomain?: string;
}

export type OwnerAuthzResult = { ok: true } | { ok: false; message: string };

// GitHub logins: alphanumerics and single hyphens, no leading/trailing hyphen,
// at most 39 characters. oauth2-proxy compares them case-sensitively.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Deliberately simple; it only has to reject non-emails (and commas, which
// would split an entry in the CSV emails file).
const EMAIL = /^[^\s@,"]+@[^\s@,"]+\.[^\s@,"]+$/;

// With a central auth host the github owner is the account's verified
// primary email (ADR 0009 Option 1), checked by the emails file.
function identityKind(
  provider: OwnerAuthzConfig['provider'],
  centralAuthHost: boolean,
): { re: RegExp; label: string } {
  if (provider !== 'github') return { re: EMAIL, label: 'an email address' };
  return centralAuthHost
    ? { re: EMAIL, label: 'the verified primary GitHub email of the owner' }
    : { re: GITHUB_LOGIN, label: 'a GitHub login' };
}

/**
 * Refuse owner-only pod-up when the owner (or an admin) is not a usable
 * identity for the provider, or falls outside the deployment-wide allowlist
 * that owner-only replaces (github allowedUsers, oidc allowedEmailDomains).
 */
export function validateOwnerAuthorization(auth: OwnerAuthzConfig, owner: string | undefined): OwnerAuthzResult {
  if (!auth.ownerOnly) return { ok: true };
  const central = auth.centralAuthHost === true;
  const { re, label } = identityKind(auth.provider, central);
  const prefix =
    `Refusing browser-mode pod-up: auth.browser.ownerOnly is true with provider "${auth.provider}"` +
    (central ? ' and auth.browser.centralAuthHost' : '');
  // pod-cli falls back to GITHUB_ACTOR, a login, so this mode needs an
  // explicit email owner on every pod-up.
  const githubCentralHint =
    central && auth.provider === 'github'
      ? ' With centralAuthHost the github owner is a verified primary GitHub email, and the default owner (the workflow actor) is a login, so pass an explicit email: pod-up -f owner=<email>.'
      : '';

  if (central && auth.adminUsers.length > 0) {
    return {
      ok: false,
      message: `${prefix} but auth.browser.adminUsers is not empty; centralAuthHost refuses admins (ADR 0009). Fix config/config.yaml and re-deploy.`,
    };
  }
  if (!owner?.trim()) {
    return {
      ok: false,
      message: `${prefix} but no owner was given. Pass the owner input (${label}) to pod-up.${githubCentralHint}`,
    };
  }
  if (!re.test(owner)) {
    return { ok: false, message: `${prefix} but owner "${owner}" is not ${label}.${githubCentralHint}` };
  }
  const badAdmin = auth.adminUsers.find((a) => !re.test(a));
  if (badAdmin !== undefined) {
    return {
      ok: false,
      message: `${prefix} but auth.browser.adminUsers entry "${badAdmin}" is not ${label}. Fix config/config.yaml and re-deploy CloudDevPods-PodManager.`,
    };
  }

  if (auth.provider === 'github' && central) {
    // allowedUsers holds logins and cannot be compared with an email; both
    // login paths (auth.<baseDomain> and the sidecar's own callback) enforce
    // it. allowedEmailDomains is not enforced for github anywhere, so
    // checking it here would make the config look stricter than it is.
  } else if (auth.provider === 'github') {
    const allowed = auth.allowedUsers.map((u) => u.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(owner) && !auth.adminUsers.includes(owner)) {
      return {
        ok: false,
        message: `${prefix} but owner "${owner}" is not in auth.browser.allowedUsers or auth.browser.adminUsers.`,
      };
    }
  } else {
    const domains = (auth.allowedEmailDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
    const domain = owner.split('@')[1]!.toLowerCase();
    if (domains.length > 0 && !domains.includes('*') && !domains.includes(domain)) {
      return {
        ok: false,
        message: `${prefix} but owner "${owner}" is not in auth.browser.allowedEmailDomains.`,
      };
    }
  }
  return { ok: true };
}

export interface OwnerAuthorization {
  sidecarEnvironment: KeyValuePair[];
  removeSidecarEnvironment: string[];
  removeSidecarSecrets: string[];
  sidecarMountPoints: MountPoint[];
  sidecarDependsOn: NonNullable<ContainerDefinition['dependsOn']>;
  initContainer?: ContainerDefinition;
  volumes: Volume[];
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The owner-only additions to the oauth2-proxy sidecar and task definition.
 * A no-op when ownerOnly is false. Assumes validateOwnerAuthorization passed.
 */
export function buildOwnerAuthorization(
  auth: OwnerAuthzConfig,
  owner: string,
  opts: OwnerAuthzOptions,
): OwnerAuthorization {
  const none: OwnerAuthorization = {
    sidecarEnvironment: [],
    removeSidecarEnvironment: [],
    removeSidecarSecrets: [],
    sidecarMountPoints: [],
    sidecarDependsOn: [],
    volumes: [],
  };
  if (!auth.ownerOnly) return none;
  const central = auth.centralAuthHost === true;

  let provider: Pick<OwnerAuthorization, 'sidecarEnvironment' | 'removeSidecarEnvironment'>;
  let initEnvironment: KeyValuePair[] = [];
  // chmod: the sidecar runs as a non-root user and must be able to enter the
  // volume directory, whatever mode ECS creates it with. With a central auth
  // host the cookie secret is the shared one, so no per-task secret file.
  const script = ['set -eu', 'umask 022', `chmod 755 ${OWNER_AUTHZ_DIR}`, ...(central ? [] : [WRITE_COOKIE_SECRET])];

  if (central) {
    // Every provider: the per-request emails file, EMAIL_DOMAINS removed.
    // The builder's GITHUB_ORG / GITHUB_USERS (deployment-wide) stay.
    // adminUsers is empty in this mode (validated), so the owner is the only
    // entry. The emails arrive through an env var, never the script.
    const org = auth.provider === 'github' ? auth.allowedOrg?.trim() : undefined;
    provider = {
      sidecarEnvironment: [
        { name: 'OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE', value: OWNER_AUTHZ_EMAILS_PATH },
        ...(org ? [{ name: 'OAUTH2_PROXY_ALLOWED_GROUPS', value: org }] : []),
      ],
      removeSidecarEnvironment: ['OAUTH2_PROXY_EMAIL_DOMAINS'],
    };
    initEnvironment = [
      { name: 'OWNER_AUTHZ_EMAILS', value: owner.toLowerCase() },
      { name: 'OWNER_AUTHZ_SIGN_IN_TEMPLATE', value: SIGN_IN_TEMPLATE },
    ];
    script.push(WRITE_EMAILS, WRITE_SIGN_IN_TEMPLATE);
  } else if (auth.provider === 'github') {
    const org = auth.allowedOrg?.trim();
    provider = {
      removeSidecarEnvironment: ['OAUTH2_PROXY_GITHUB_ORG', 'OAUTH2_PROXY_GITHUB_USERS'],
      sidecarEnvironment: [
        { name: 'OAUTH2_PROXY_GITHUB_USERS', value: dedupe([owner, ...auth.adminUsers]).join(',') },
        ...(org ? [{ name: 'OAUTH2_PROXY_ALLOWED_GROUPS', value: org }] : []),
      ],
    };
  } else {
    // oidc / entra-id: oauth2-proxy has no inline email allowlist, so the init
    // container also writes the emails file. The emails arrive through an env
    // var, never interpolated into the script.
    const emails = dedupe([owner, ...auth.adminUsers].map((e) => e.toLowerCase()));
    provider = {
      sidecarEnvironment: [{ name: 'OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE', value: OWNER_AUTHZ_EMAILS_PATH }],
      removeSidecarEnvironment: ['OAUTH2_PROXY_EMAIL_DOMAINS'],
    };
    initEnvironment = [{ name: 'OWNER_AUTHZ_EMAILS', value: emails.join(',') }];
    script.push(WRITE_EMAILS);
  }

  // One init container writes the per-task files into a task-scoped
  // ephemeral volume that only it and the sidecar mount.
  return {
    sidecarEnvironment: [
      ...provider.sidecarEnvironment,
      ...(central ? [] : [{ name: 'OAUTH2_PROXY_COOKIE_SECRET_FILE', value: OWNER_AUTHZ_COOKIE_SECRET_PATH }]),
    ],
    removeSidecarEnvironment: provider.removeSidecarEnvironment,
    removeSidecarSecrets: central ? [] : ['OAUTH2_PROXY_COOKIE_SECRET'],
    sidecarMountPoints: [{ sourceVolume: OWNER_AUTHZ_VOLUME, containerPath: OWNER_AUTHZ_DIR, readOnly: true }],
    // oauth2-proxy exits if a file is missing, so wait for them.
    sidecarDependsOn: [{ containerName: OWNER_AUTHZ_INIT_CONTAINER, condition: 'SUCCESS' }],
    volumes: [{ name: OWNER_AUTHZ_VOLUME }],
    initContainer: {
      name: OWNER_AUTHZ_INIT_CONTAINER,
      image: opts.initImage,
      essential: false,
      // The runtime image runs as a non-root user; the fresh volume is
      // root-owned. The container only writes its files and exits. The files
      // are world-readable because oauth2-proxy runs as a distinct non-root
      // user; the vscode container does not mount the volume.
      user: '0',
      entryPoint: ['sh', '-c'],
      command: [script.join(' && ')],
      ...(initEnvironment.length ? { environment: initEnvironment } : {}),
      mountPoints: [{ sourceVolume: OWNER_AUTHZ_VOLUME, containerPath: OWNER_AUTHZ_DIR, readOnly: false }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': opts.logGroupName,
          'awslogs-region': opts.region,
          'awslogs-stream-prefix': `browser/${opts.podName}/${OWNER_AUTHZ_INIT_CONTAINER}`,
        },
      },
    },
  };
}

/**
 * The auth containers and volumes for a browser task: the oauth2-proxy
 * sidecar, plus the owner-only init container and volume when enabled (all
 * providers: it writes the per-pod cookie secret, and the emails file for
 * oidc / entra-id). With
 * ownerOnly false the result is exactly [buildOauth2ProxyContainer(...)].
 */
export function buildBrowserAuthTaskParts(
  auth: OwnerAuthzConfig,
  owner: string,
  secretArns: Oauth2ProxySecretArns,
  opts: OwnerAuthzOptions,
): { containers: ContainerDefinition[]; volumes: Volume[] } {
  const { initImage: _initImage, baseDomain, ...sidecarOpts } = opts;
  if (auth.centralAuthHost) {
    // The synth guard enforces all three; re-checked so a bad Lambda env can
    // never produce a sidecar that accepts the shared cookie without the
    // per-request owner check, or that admits admins.
    if (!auth.ownerOnly) throw new Error('centralAuthHost requires auth.browser.ownerOnly: true (ADR 0009).');
    if (auth.adminUsers.length > 0) throw new Error('centralAuthHost requires an empty auth.browser.adminUsers (ADR 0009).');
    if (!baseDomain) throw new Error('centralAuthHost requires domain.baseDomain (BASE_DOMAIN is empty).');
  }
  const sidecar = buildOauth2ProxyContainer(
    auth,
    secretArns,
    auth.centralAuthHost
      ? { ...sidecarOpts, centralAuthHost: { baseDomain: baseDomain!, customTemplatesDir: OWNER_AUTHZ_TEMPLATES_DIR } }
      : sidecarOpts,
  );
  if (!auth.ownerOnly) return { containers: [sidecar], volumes: [] };

  const o = buildOwnerAuthorization(auth, owner, opts);
  const environment = [
    ...(sidecar.environment ?? []).filter((e) => !o.removeSidecarEnvironment.includes(e.name ?? '')),
    ...o.sidecarEnvironment,
  ];
  const withOwner: ContainerDefinition = {
    ...sidecar,
    environment,
    secrets: (sidecar.secrets ?? []).filter((e) => !o.removeSidecarSecrets.includes(e.name ?? '')),
    ...(o.sidecarMountPoints.length ? { mountPoints: [...(sidecar.mountPoints ?? []), ...o.sidecarMountPoints] } : {}),
    dependsOn: [...(sidecar.dependsOn ?? []), ...o.sidecarDependsOn],
  };
  return {
    containers: o.initContainer ? [o.initContainer, withOwner] : [withOwner],
    volumes: o.volumes,
  };
}
