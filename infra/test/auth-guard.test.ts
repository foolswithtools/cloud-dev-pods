import { describe, expect, it } from 'vitest';
import {
  assertBrowserAuthRestricted,
  type BrowserAuthRestrictions,
} from '../lambda/pod-manager/auth-guard';

// Same shape env.auth.browser has when every AUTH_BROWSER_* var is unset.
function browser(overrides: Partial<BrowserAuthRestrictions> = {}): BrowserAuthRestrictions {
  return {
    provider: 'github',
    allowedOrg: '',
    allowedUsers: [],
    allowedGroups: [],
    allowedEmailDomains: [],
    allowedTenants: [],
    ownerOnly: false,
    ...overrides,
  };
}

function refusal(auth: BrowserAuthRestrictions): string {
  const r = assertBrowserAuthRestricted(auth);
  if (r.ok) throw new Error('expected a refusal, got ok');
  return r.message;
}

describe('assertBrowserAuthRestricted: github', () => {
  it('refuses github with no org or users and names both keys', () => {
    const message = refusal(browser());
    expect(message).toContain('auth.browser.allowedOrg');
    expect(message).toContain('auth.browser.allowedUsers');
    expect(message).toContain('"github"');
  });

  it('passes github with allowedUsers', () => {
    expect(assertBrowserAuthRestricted(browser({ allowedUsers: ['alice'] }))).toEqual({ ok: true });
  });

  it('passes github with allowedOrg', () => {
    expect(assertBrowserAuthRestricted(browser({ allowedOrg: 'acme' }))).toEqual({ ok: true });
  });

  it('refuses github whose only settings are blank strings', () => {
    expect(assertBrowserAuthRestricted(browser({ allowedOrg: '  ', allowedUsers: ['', ' '] })).ok).toBe(false);
  });

  it('does not count settings that github ignores (groups, email domains, tenants)', () => {
    const message = refusal(
      browser({ allowedGroups: ['g1'], allowedEmailDomains: ['example.com'], allowedTenants: ['t1'] }),
    );
    expect(message).not.toContain('auth.browser.allowedTenants');
  });
});

describe('assertBrowserAuthRestricted: oidc', () => {
  it('refuses oidc with only allowedEmailDomains ["*"]', () => {
    const message = refusal(browser({ provider: 'oidc', allowedEmailDomains: ['*'] }));
    expect(message).toContain('auth.browser.allowedGroups');
    expect(message).toContain('auth.browser.allowedEmailDomains');
    expect(message).toContain('auth.browser.ownerOnly');
    expect(message).toContain('"*"');
    expect(message).not.toContain('auth.browser.allowedOrg');
    expect(message).not.toContain('auth.browser.allowedTenants');
  });

  it('refuses oidc when "*" appears alongside a real domain (oauth2-proxy would admit everyone)', () => {
    expect(
      assertBrowserAuthRestricted(browser({ provider: 'oidc', allowedEmailDomains: ['example.com', '*'] })).ok,
    ).toBe(false);
  });

  it('refuses oidc with nothing set', () => {
    expect(assertBrowserAuthRestricted(browser({ provider: 'oidc' })).ok).toBe(false);
  });

  it('passes oidc with allowedGroups', () => {
    expect(assertBrowserAuthRestricted(browser({ provider: 'oidc', allowedGroups: ['devs'] }))).toEqual({ ok: true });
  });

  it('passes oidc with a real allowedEmailDomains entry', () => {
    expect(
      assertBrowserAuthRestricted(browser({ provider: 'oidc', allowedEmailDomains: ['example.com'] })),
    ).toEqual({ ok: true });
  });

  it('does not count github-only settings for oidc', () => {
    expect(
      assertBrowserAuthRestricted(browser({ provider: 'oidc', allowedOrg: 'acme', allowedUsers: ['alice'] })).ok,
    ).toBe(false);
  });
});

describe('assertBrowserAuthRestricted: entra-id', () => {
  it('passes entra-id with allowedTenants', () => {
    expect(
      assertBrowserAuthRestricted(browser({ provider: 'entra-id', allowedTenants: ['tenant-guid'] })),
    ).toEqual({ ok: true });
  });

  it('passes entra-id with allowedGroups or a real allowedEmailDomains entry', () => {
    expect(assertBrowserAuthRestricted(browser({ provider: 'entra-id', allowedGroups: ['g'] })).ok).toBe(true);
    expect(
      assertBrowserAuthRestricted(browser({ provider: 'entra-id', allowedEmailDomains: ['example.com'] })).ok,
    ).toBe(true);
  });

  it('refuses entra-id with only ["*"] and names its four keys', () => {
    const message = refusal(browser({ provider: 'entra-id', allowedEmailDomains: ['*'] }));
    for (const key of ['allowedTenants', 'allowedGroups', 'allowedEmailDomains', 'ownerOnly']) {
      expect(message).toContain(`auth.browser.${key}`);
    }
    expect(message).not.toContain('auth.browser.allowedOrg');
  });
});

describe('assertBrowserAuthRestricted: ownerOnly', () => {
  it.each(['github', 'entra-id', 'oidc'] as const)('passes %s with ownerOnly: true', (provider) => {
    expect(assertBrowserAuthRestricted(browser({ provider, ownerOnly: true }))).toEqual({ ok: true });
  });
});
