/**
 * Unit Tests: entitlement switches (§135 t-1033)
 *
 * The registry an app fills from `lib/app/entitlements.ts`, and what an org's
 * stored switches mean against it. Pins: the seam ships empty and changes no
 * answer; a throwing init rolls back every switch it registered; an org with
 * nothing set answers each switch's `whenNothingSet`, which is not the same
 * as an org set to none; a stored key nobody registers reads as off; a typo
 * fails closed.
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
  registeredEntitlementSwitch,
  registeredEntitlementSwitches,
  resolveOrgSwitches,
} from '@/lib/tenancy/entitlements';

const ORG = 'cmorg000000000000000acme1';

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
    for (const read of [
      { set: false } as const,
      { set: true, switches: ['reports'], unreadable: false } as const,
    ]) {
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
    expect(registeredEntitlementSwitch('leads')?.label).toBe('Lead generation');
    expect(registeredEntitlementSwitch('nope')).toBeUndefined();
  });

  it('runs the fork init once, however many reads there are', () => {
    registerBoth();

    registeredEntitlementSwitches();
    registeredEntitlementSwitches();
    registeredEntitlementSwitch('reports');

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

  it('refuses a switch with no label', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'reports', label: '   ', description: '' });
    });

    expect(registeredEntitlementSwitches()).toEqual([]);
  });
});

describe('resolveOrgSwitches', () => {
  beforeEach(registerBoth);

  it('gives an org with nothing set each switch at its default', () => {
    expect(resolveOrgSwitches({ set: false })).toEqual({
      nothingSet: true,
      unreadable: false,
      on: ['leads'],
      unregistered: [],
    });
  });

  it('gives an org set to none no switch at all, which is not the same as nothing set', () => {
    const none = resolveOrgSwitches({ set: true, switches: [], unreadable: false });
    const nothing = resolveOrgSwitches({ set: false });

    expect(none).toEqual({ nothingSet: false, unreadable: false, on: [], unregistered: [] });
    // The whole point of the two states: an app's default-on switch is lost
    // only by an org somebody actually set.
    expect(nothing.on).toContain('leads');
    expect(none.on).not.toContain('leads');
  });

  it('gives a set org exactly what was set, in registration order', () => {
    expect(
      resolveOrgSwitches({ set: true, switches: ['leads', 'reports'], unreadable: false }).on
    ).toEqual(['reports', 'leads']);
    expect(resolveOrgSwitches({ set: true, switches: ['reports'], unreadable: false }).on).toEqual([
      'reports',
    ]);
  });

  it('reads a stored key nobody registers as off, and names it', () => {
    expect(
      resolveOrgSwitches({ set: true, switches: ['reports', 'retired'], unreadable: false })
    ).toEqual({ nothingSet: false, unreadable: false, on: ['reports'], unregistered: ['retired'] });
  });

  it('passes an unreadable slice through as set, with nothing on', () => {
    expect(resolveOrgSwitches({ set: true, switches: [], unreadable: true })).toEqual({
      nothingSet: false,
      unreadable: true,
      on: [],
      unregistered: [],
    });
  });
});

describe('loading an org', () => {
  beforeEach(registerBoth);

  it("reads the org's row and resolves it", async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { switches: ['reports'] }, appOwn: { x: 1 } },
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
      settings: { entitlements: { switches: ['repots'] } },
    });

    await expect(orgHasSwitch(ORG, 'repots')).resolves.toBe(false);
  });
});
