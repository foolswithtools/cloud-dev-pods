// Fail-fast guard for browser pod-up (spec F2). oauth2-proxy runs with
// EMAIL_DOMAINS=* unless told otherwise, so a browser pod with no restriction
// for the active provider would admit every account the IdP can authenticate.
// Pure: no env reads, so it can be unit-tested; actions.ts passes in
// env.auth.browser, the same source the oauth2-proxy sidecar builder reads.

export interface BrowserAuthRestrictions {
  provider: 'github' | 'entra-id' | 'oidc';
  allowedOrg?: string;
  allowedUsers: readonly string[];
  allowedGroups: readonly string[];
  allowedEmailDomains: readonly string[];
  allowedTenants: readonly string[];
  ownerOnly: boolean;
}

export type BrowserAuthGuardResult = { ok: true } | { ok: false; message: string };

type RestrictionKey = Exclude<keyof BrowserAuthRestrictions, 'provider'>;

// The keys that restrict who can sign in, per provider. Keys a provider
// ignores (e.g. allowedTenants for github) don't count for it.
const RESTRICTION_KEYS: Record<BrowserAuthRestrictions['provider'], readonly RestrictionKey[]> = {
  github: ['allowedOrg', 'allowedUsers', 'ownerOnly'],
  'entra-id': ['allowedTenants', 'allowedGroups', 'allowedEmailDomains', 'ownerOnly'],
  oidc: ['allowedGroups', 'allowedEmailDomains', 'ownerOnly'],
};

function isSet(auth: BrowserAuthRestrictions, key: RestrictionKey): boolean {
  if (key === 'ownerOnly') return auth.ownerOnly;
  if (key === 'allowedOrg') return Boolean(auth.allowedOrg?.trim());
  const values = auth[key].map((v) => v.trim()).filter(Boolean);
  // oauth2-proxy admits every address when "*" is among the email domains,
  // so a wildcard anywhere in the list cancels the restriction.
  if (key === 'allowedEmailDomains' && values.includes('*')) return false;
  return values.length > 0;
}

export function assertBrowserAuthRestricted(auth: BrowserAuthRestrictions): BrowserAuthGuardResult {
  const keys = RESTRICTION_KEYS[auth.provider];
  if (keys.some((key) => isSet(auth, key))) return { ok: true };

  // ownerOnly is listed last and phrased as a boolean; the rest are values.
  const valueKeys = keys.filter((k) => k !== 'ownerOnly').map((k) => `auth.browser.${k}`);
  const choices = auth.provider === 'github' ? valueKeys : [...valueKeys, 'auth.browser.ownerOnly: true'];
  const wildcardNote = keys.includes('allowedEmailDomains')
    ? ' allowedEmailDomains: ["*"] does not count as a restriction.'
    : '';
  return {
    ok: false,
    message:
      `Refusing browser-mode pod-up: auth.browser.provider "${auth.provider}" has no sign-in restriction, ` +
      `so any account the identity provider accepts could open the pod. ` +
      `Set at least one of ${choices.join(', ')} in config/config.yaml and re-deploy CloudDevPods-PodManager.` +
      wildcardNote,
  };
}
