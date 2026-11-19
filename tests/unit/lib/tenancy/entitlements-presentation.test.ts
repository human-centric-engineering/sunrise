/**
 * Unit Tests: how a switch an org lacks is presented, and who may set it
 * (§135 t-1053, t-1054)
 *
 * Pins: a switch registered with none of the new fields refuses with the
 * platform's sentence, hides, and is platform-set; an app's own refusal
 * message replaces the sentence and its upgrade URL is kept; a value that is
 * not one of the allowed ones throws, which rolls back the init, so a typo
 * neither shows a surface it meant to hide nor lets an org set what it buys;
 * an upgrade URL that is not a site path or an https address is refused.
 *
 * @see lib/tenancy/entitlements.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { initAppEntitlements } from '@/lib/app/entitlements';
import {
  __resetEntitlementRegistryForTests,
  entitlementSwitchesFailed,
  MAX_SWITCH_REFUSAL_MESSAGE,
  registerEntitlementSwitch,
  registeredEntitlementSwitches,
  switchRequiredMessage,
  switchUpgradeUrl,
  type EntitlementSwitch,
} from '@/lib/tenancy/entitlements';

/** Register one switch with these extra fields, and return whether the init held. */
function register(extra: Partial<EntitlementSwitch> | Record<string, unknown>): boolean {
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerEntitlementSwitch({
      key: 'reports',
      label: 'Reports',
      description: 'Build and share reports.',
      ...extra,
    });
  });
  return !entitlementSwitchesFailed();
}

beforeEach(() => {
  __resetEntitlementRegistryForTests();
  vi.clearAllMocks();
  vi.mocked(initAppEntitlements).mockImplementation(() => {});
});

describe('the defaults (t-1053, t-1054)', () => {
  it('hides, refuses with the platform sentence, offers no link and is platform-set', () => {
    expect(register({})).toBe(true);

    const [registered] = registeredEntitlementSwitches();
    expect(registered).toMatchObject({
      whenLacking: 'hide',
      refusalMessage: null,
      upgradeUrl: null,
      setBy: 'platform',
    });
    expect(switchRequiredMessage('reports')).toBe(
      "Your organisation does not have Reports. Ask whoever manages your organisation's account to switch it on."
    );
    expect(switchUpgradeUrl('reports')).toBeNull();
  });

  it('answers no link for a key nothing registers', () => {
    expect(switchUpgradeUrl('reports')).toBeNull();
    expect(switchRequiredMessage('reports')).toContain('does not have reports');
  });
});

describe("an app's own refusal (t-1053)", () => {
  it('replaces the platform sentence with its message, trimmed, and keeps its link', () => {
    expect(
      register({
        whenLacking: 'lock',
        refusalMessage: '  Reports come with the Team plan.  ',
        upgradeUrl: '/pricing#team',
      })
    ).toBe(true);

    expect(registeredEntitlementSwitches()[0]?.whenLacking).toBe('lock');
    expect(switchRequiredMessage('reports')).toBe('Reports come with the Team plan.');
    expect(switchUpgradeUrl('reports')).toBe('/pricing#team');
  });

  it('takes an https address', () => {
    expect(register({ upgradeUrl: 'https://example.com/plans?from=app' })).toBe(true);
    expect(switchUpgradeUrl('reports')).toBe('https://example.com/plans?from=app');
  });

  it.each([
    ['a script', 'javascript:alert(1)'],
    ['another host by a protocol-relative path', '//evil.example/plans'],
    ['plain http', 'http://example.com/plans'],
    ['a bare word', 'pricing'],
    ['a backslash path', '/\\evil.example'],
    ['whitespace', '/pricing page'],
    ['an empty string', ''],
    ['not a string', 42],
  ])('refuses %s as an upgrade URL, and the init rolls back', (_name, upgradeUrl) => {
    expect(register({ upgradeUrl })).toBe(false);
    expect(registeredEntitlementSwitches()).toEqual([]);
  });

  it.each([
    ['empty', '   '],
    ['too long', 'x'.repeat(MAX_SWITCH_REFUSAL_MESSAGE + 1)],
    ['not a string', true],
  ])('refuses a refusal message that is %s', (_name, refusalMessage) => {
    expect(register({ refusalMessage })).toBe(false);
  });

  it("refuses a whenLacking that is neither 'hide' nor 'lock'", () => {
    expect(register({ whenLacking: 'show' })).toBe(false);
  });
});

describe('who may set it (t-1054)', () => {
  it("takes 'org'", () => {
    expect(register({ setBy: 'org' })).toBe(true);
    expect(registeredEntitlementSwitches()[0]?.setBy).toBe('org');
  });

  it.each([['Org'], ['members'], [true]])(
    'refuses setBy %j, so a typo cannot hand an org a switch it buys',
    (setBy) => {
      expect(register({ setBy })).toBe(false);
      expect(registeredEntitlementSwitches()).toEqual([]);
    }
  );
});
