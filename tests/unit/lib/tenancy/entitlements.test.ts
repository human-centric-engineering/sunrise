/**
 * Unit Tests: entitlement switches (§135 t-1033)
 *
 * The registry an app fills from `lib/app/entitlements.ts`, and what an org's
 * stored switches mean against it. Pins: the seam ships empty and changes no
 * answer; a throwing init rolls back every switch it registered; a switch
 * nobody set on an org answers its `whenNothingSet`, which is not the same as
 * a switch set off, and a switch registered after an org was saved reaches it
 * at its default; a stored key nobody registers reads as off; a typo fails
 * closed.
 *
 * @see lib/tenancy/entitlements.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The fork seam ships empty; the tests below fill it explicitly.
vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockPrisma = vi.hoisted(() => ({ org: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import { initAppEntitlements } from '@/lib/app/entitlements';
import { logger } from '@/lib/logging';
import {
  __resetEntitlementRegistryForTests,
  loadOrgSwitches,
  orgHasSwitch,
  registerEntitlementSwitch,
  registeredEntitlementSwitches,
  resolveOrgSwitches,
  type EntitlementSwitch,
} from '@/lib/tenancy/entitlements';

const ORG = 'cmorg000000000000000acme1';

/** What is stored: the keys set on and off. Nothing set by default. */
const stored = (on: string[] = [], off: string[] = [], unreadable = false) => ({
  on,
  off,
  unreadable,
});

/** Register the two switches most tests use: one new area, one every org has today. */
function registerBoth() {
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerEntitlementSwitch({
      key: 'reports',
      label: 'Reports',
      description: 'Build and share reports.',
    });
    registerEntitlementSwitch({
      key: 'leads',
      label: 'Lead generation',
      description: 'Funnels and leads.',
      whenNothingSet: true,
    });
  });
}

beforeEach(() => {
  __resetEntitlementRegistryForTests();
  vi.clearAllMocks();
  vi.mocked(initAppEntitlements).mockImplementation(() => {});
});

describe('the registry', () => {
  it('ships empty, so an org of any shape has no switch on', () => {
    expect(registeredEntitlementSwitches()).toEqual([]);
    for (const read of [stored(), stored(['reports']), stored([], ['reports'])]) {
      expect(resolveOrgSwitches(read).on).toEqual([]);
    }
  });

  it('lists switches in registration order, with whenNothingSet filled in as off', () => {
    registerBoth();

    expect(registeredEntitlementSwitches()).toEqual([
      {
        key: 'reports',
        label: 'Reports',
        description: 'Build and share reports.',
        whenNothingSet: false,
      },
      {
        key: 'leads',
        label: 'Lead generation',
        description: 'Funnels and leads.',
        whenNothingSet: true,
      },
    ]);
  });

  it('runs the fork init once, however many reads there are', () => {
    registerBoth();

    registeredEntitlementSwitches();
    registeredEntitlementSwitches();
    resolveOrgSwitches(stored());

    expect(initAppEntitlements).toHaveBeenCalledOnce();
  });

  it('replaces a switch registered twice under one key', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Old', description: '' });
      registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: 'New' });
    });

    expect(registeredEntitlementSwitches()).toEqual([
      { key: 'reports', label: 'Reports', description: 'New', whenNothingSet: false },
    ]);
  });

  it('rolls back every switch when the init throws part-way, and says so', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
      throw new Error('boom');
    });

    expect(registeredEntitlementSwitches()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('entitlements: initAppEntitlements threw'),
      expect.anything()
    );
  });

  it.each([
    ['upper case', 'Reports'],
    ['a hyphen', 'lead-gen'],
    ['a leading digit', '1reports'],
    ['nothing', ''],
  ])('refuses a key with %s, which rolls the init back', (_what, key) => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'leads', label: 'Leads', description: '' });
      registerEntitlementSwitch({ key, label: 'Bad', description: '' });
    });

    expect(registeredEntitlementSwitches()).toEqual([]);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('refuses a switch with no label, or a label left out, with a message rather than a TypeError', () => {
    for (const label of ['   ', undefined]) {
      __resetEntitlementRegistryForTests();
      vi.mocked(logger.error).mockClear();
      vi.mocked(initAppEntitlements).mockImplementation(() => {
        registerEntitlementSwitch({ key: 'reports', label, description: '' } as never);
      });

      expect(registeredEntitlementSwitches()).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('entitlements: initAppEntitlements threw'),
        expect.objectContaining({ error: expect.stringContaining('needs a label') })
      );
    }
  });

  it('reads a description left out as none, rather than failing the whole init', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Reports' } as EntitlementSwitch);
    });

    expect(registeredEntitlementSwitches()).toEqual([
      { key: 'reports', label: 'Reports', description: '', whenNothingSet: false },
    ]);
  });
});

describe('resolveOrgSwitches', () => {
  beforeEach(registerBoth);

  it('gives an org with nothing set each switch at its default', () => {
    expect(resolveOrgSwitches(stored())).toEqual({
      nothingSet: true,
      unreadable: false,
      on: ['leads'],
      atDefault: ['reports', 'leads'],
      unregistered: [],
    });
  });

  it('gives an org set to none no switch at all, which is not the same as nothing set', () => {
    const none = resolveOrgSwitches(stored([], ['leads', 'reports']));
    const nothing = resolveOrgSwitches(stored());

    expect(none).toEqual({
      nothingSet: false,
      unreadable: false,
      on: [],
      atDefault: [],
      unregistered: [],
    });
    // The whole point: a default-on switch is lost only where somebody set it off.
    expect(nothing.on).toContain('leads');
    expect(none.on).not.toContain('leads');
  });

  it('gives a set org exactly what was set, in registration order', () => {
    expect(resolveOrgSwitches(stored(['leads', 'reports'])).on).toEqual(['reports', 'leads']);
    expect(resolveOrgSwitches(stored(['reports'], ['leads'])).on).toEqual(['reports']);
  });

  it('gives a switch registered after the org was saved its default, not off', () => {
    // Saved when only `reports` was registered: reports on, nothing else known.
    const savedEarlier = stored(['reports']);

    const resolved = resolveOrgSwitches(savedEarlier);

    // `leads` arrived later with whenNothingSet: true, so this org has it,
    // like every org that exists today.
    expect(resolved.on).toEqual(['reports', 'leads']);
    expect(resolved.atDefault).toEqual(['leads']);
    expect(resolved.nothingSet).toBe(false);
  });

  it('reads a stored key nobody registers as off, and names it', () => {
    expect(resolveOrgSwitches(stored(['reports', 'retired'], ['leads']))).toEqual({
      nothingSet: false,
      unreadable: false,
      on: ['reports'],
      atDefault: [],
      unregistered: ['retired'],
    });
  });

  it('gives an unreadable slice nothing, not even the defaults', () => {
    expect(resolveOrgSwitches(stored([], [], true))).toEqual({
      nothingSet: false,
      unreadable: true,
      on: [],
      atDefault: [],
      unregistered: [],
    });
  });
});

describe('loading an org', () => {
  beforeEach(registerBoth);

  it("reads the org's row and resolves it", async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['reports'], off: ['leads'] }, appOwn: { x: 1 } },
    });

    await expect(loadOrgSwitches(ORG)).resolves.toMatchObject({
      nothingSet: false,
      on: ['reports'],
    });
    expect(mockPrisma.org.findUnique).toHaveBeenCalledWith({
      where: { id: ORG },
      select: { settings: true },
    });
  });

  it('is null for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    await expect(loadOrgSwitches(ORG)).resolves.toBeNull();
    await expect(orgHasSwitch(ORG, 'leads')).resolves.toBe(false);
  });

  it('answers one switch, with the default for an org nothing was set on', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ settings: null });

    await expect(orgHasSwitch(ORG, 'leads')).resolves.toBe(true);
    await expect(orgHasSwitch(ORG, 'reports')).resolves.toBe(false);
  });

  it('fails closed on a key nobody registers, even one stored on the org', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['repots'], off: [] } },
    });

    await expect(orgHasSwitch(ORG, 'repots')).resolves.toBe(false);
  });
});
