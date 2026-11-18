/**
 * Unit Tests: meters (§135 t-1035)
 *
 * What an org uses against a limit platform staff set. Pins: the platform's
 * seats meter and how an app's `seats` replaces it; the window arithmetic;
 * the seats count's queries; and that `checkMeterQuota` fails open (and says
 * so in the log) on every way a meter can be broken, never throwing.
 *
 * @see lib/tenancy/meters.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockPrisma = vi.hoisted(() => ({
  orgMembership: { count: vi.fn() },
  verification: { count: vi.fn(), findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

const mockLoadLimits = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/org-settings', () => ({ loadOrgMeterLimits: mockLoadLimits }));

import { initAppEntitlements } from '@/lib/app/entitlements';
import { APIError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';
import {
  METER_LIMIT_REASON,
  SEATS_METER_KEY,
  allMeters,
  checkMeterQuota,
  countSeats,
  loadOrgMeterUsage,
  meterLimitMessage,
  meterOf,
  meterWindow,
  refuseOverSeatsLimit,
} from '@/lib/tenancy/meters';
import {
  __resetEntitlementRegistryForTests,
  registerMeter,
  type MeterDefinition,
} from '@/lib/tenancy/entitlements';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const ORG = 'cmorg000000000000000acme1';
const NOW = new Date('2026-03-15T10:30:00.000Z');

/** Have the app register these meters when the registry first loads. */
function appRegisters(...defs: MeterDefinition[]) {
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    for (const def of defs) registerMeter(def);
  });
}

const meter = (
  key: string,
  count: MeterDefinition['count'],
  period: MeterDefinition['period'] = 'standing'
) =>
  ({
    key,
    label: `Label ${key}`,
    description: `Desc ${key}`,
    period,
    count,
  }) satisfies MeterDefinition;

beforeEach(() => {
  __resetEntitlementRegistryForTests();
  vi.resetAllMocks();
  vi.mocked(initAppEntitlements).mockImplementation(() => {});
  mockPrisma.orgMembership.count.mockResolvedValue(0);
  mockPrisma.verification.count.mockResolvedValue(0);
  mockPrisma.verification.findMany.mockResolvedValue([]);
  mockLoadLimits.mockResolvedValue({});
});

describe('allMeters / meterOf', () => {
  it('is the core seats meter alone on vanilla Sunrise', () => {
    const all = allMeters();

    expect(all.map((m) => m.key)).toEqual(['seats']);
    expect(all[0]).toMatchObject({ core: true, label: 'Seats', period: 'standing' });
    expect(meterOf('seats')).toBe(all[0]);
    expect(meterOf('nope')).toBeUndefined();
  });

  it('counts the core seats meter through countSeats for the org it is asked about', async () => {
    mockPrisma.orgMembership.count.mockResolvedValue(3);
    mockPrisma.verification.count.mockResolvedValue(2);

    const used = await meterOf('seats')!.count({ orgId: ORG, from: null, to: null });

    expect(used).toBe(5);
    expect(mockPrisma.orgMembership.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: ORG }) })
    );
  });

  it('lets an app seats replace the core one, kept first and marked not core', () => {
    appRegisters(
      meter('reports', () => 1),
      meter('seats', () => 9)
    );

    const all = allMeters();

    expect(all.map((m) => m.key)).toEqual(['seats', 'reports']);
    expect(all.map((m) => m.core)).toEqual([false, false]);
    expect(all[0].label).toBe('Label seats');
  });

  it('lists app meters after seats in registration order', () => {
    appRegisters(
      meter('zeta', () => 0),
      meter('alpha', () => 0)
    );

    expect(allMeters().map((m) => [m.key, m.core])).toEqual([
      ['seats', true],
      ['zeta', false],
      ['alpha', false],
    ]);
  });
});

describe('meterWindow', () => {
  it('has no bounds for a standing meter', async () => {
    expect(await meterWindow('standing', ORG, NOW)).toEqual({ from: null, to: null });
  });

  it('is the UTC calendar month for month', async () => {
    expect(await meterWindow('month', ORG, NOW)).toEqual({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
    });
  });

  it('puts the last millisecond of a month in that month, and the first of the next in the next', async () => {
    const last = await meterWindow('month', ORG, new Date('2026-03-31T23:59:59.999Z'));
    const first = await meterWindow('month', ORG, new Date('2026-04-01T00:00:00.000Z'));

    expect(last.to).toEqual(new Date('2026-04-01T00:00:00.000Z'));
    expect(first.from).toEqual(new Date('2026-04-01T00:00:00.000Z'));
  });

  it('rolls December over into January of the next year', async () => {
    expect(await meterWindow('month', ORG, new Date('2026-12-20T12:00:00.000Z'))).toEqual({
      from: new Date('2026-12-01T00:00:00.000Z'),
      to: new Date('2027-01-01T00:00:00.000Z'),
    });
  });

  it('calls a function period with the org and now, and returns what it answers', async () => {
    const window = { from: new Date('2026-03-10T00:00:00Z'), to: new Date('2026-04-10T00:00:00Z') };
    const period = vi.fn().mockReturnValue(window);

    expect(await meterWindow(period, ORG, NOW)).toEqual(window);
    expect(period).toHaveBeenCalledWith({ orgId: ORG, now: NOW });
  });

  it('awaits an async function period', async () => {
    const window = { from: new Date('2026-03-10T00:00:00Z'), to: new Date('2026-04-10T00:00:00Z') };

    expect(await meterWindow(async () => window, ORG, NOW)).toEqual(window);
  });

  it.each([
    ['non-dates', { from: '2026-01-01', to: '2026-02-01' }],
    ['null', null],
    ['an invalid from date', { from: new Date(NaN), to: new Date('2026-02-01') }],
    ['an invalid to date', { from: new Date('2026-01-01'), to: new Date(NaN) }],
    ['from after to', { from: new Date('2026-02-01'), to: new Date('2026-01-01') }],
    ['from equal to to', { from: new Date('2026-02-01'), to: new Date('2026-02-01') }],
  ])('throws when a function period answers %s', async (_what, answer) => {
    await expect(meterWindow(() => answer as never, ORG, NOW)).rejects.toThrow(
      /did not return \{ from, to \}/
    );
  });
});

describe('countSeats', () => {
  it('counts non-staff members plus unexpired invitations naming the org by a JSON path filter', async () => {
    mockPrisma.orgMembership.count.mockResolvedValue(4);
    mockPrisma.verification.count.mockResolvedValue(2);

    const seats = await countSeats(ORG);

    expect(seats).toBe(6);
    const { where: memberWhere } = mockPrisma.orgMembership.count.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(memberWhere.orgId).toBe(ORG);
    expect(memberWhere.user).toMatchObject({ role: { not: 'ADMIN' } });
    const { where } = mockPrisma.verification.count.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where.identifier).toEqual({ startsWith: 'invitation:' });
    expect((where.expiresAt as { gt: Date }).gt).toBeInstanceOf(Date);
    expect(where.metadata).toEqual({ path: ['orgId'], equals: ORG });
    expect(mockPrisma.verification.findMany).not.toHaveBeenCalled();
  });

  it('counts only unexpired invitations, as of now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await countSeats(ORG);
    } finally {
      vi.useRealTimers();
    }

    const { where } = mockPrisma.verification.count.mock.calls[0][0] as {
      where: { expiresAt: { gt: Date } };
    };
    expect(where.expiresAt.gt).toEqual(NOW);
  });

  it('reads and filters the install org invitations, counting those naming no org or the install org', async () => {
    mockPrisma.orgMembership.count.mockResolvedValue(2);
    mockPrisma.verification.findMany.mockResolvedValue([
      { metadata: {} },
      { metadata: { orgId: null } },
      { metadata: { orgId: '' } },
      { metadata: { orgId: INSTALL_ORG_ID } },
      { metadata: { orgId: 'cmother' } },
      { metadata: null },
      { metadata: [] },
      { metadata: { orgId: 42 } },
    ]);

    // none, null, '', install, null metadata, array, non-string = 7; 'cmother' excluded
    expect(await countSeats(INSTALL_ORG_ID)).toBe(2 + 7);
    expect(mockPrisma.verification.count).not.toHaveBeenCalled();
    const arg = mockPrisma.verification.findMany.mock.calls[0][0] as {
      where: { identifier: unknown; expiresAt: { gt: Date } };
    };
    expect(arg.where.identifier).toEqual({ startsWith: 'invitation:' });
    expect(arg.where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it('uses a db it is handed rather than the default', async () => {
    const db = {
      orgMembership: { count: vi.fn().mockResolvedValue(1) },
      verification: { count: vi.fn().mockResolvedValue(1), findMany: vi.fn() },
    };

    expect(await countSeats(ORG, db as never)).toBe(2);
    expect(mockPrisma.orgMembership.count).not.toHaveBeenCalled();
  });
});

describe('checkMeterQuota', () => {
  it('allows without counting when the org has no limit for the meter', async () => {
    const count = vi.fn();
    appRegisters(meter('reports', count));
    mockLoadLimits.mockResolvedValue({ other: 5 });

    expect(await checkMeterQuota(ORG, 'reports')).toEqual({
      allowed: true,
      used: null,
      limit: null,
      label: 'Label reports',
      window: null,
    });
    expect(count).not.toHaveBeenCalled();
  });

  it('allows when the org has no seats limit, without touching the db', async () => {
    const check = await checkMeterQuota(ORG, SEATS_METER_KEY);

    expect(check.allowed).toBe(true);
    expect(mockPrisma.orgMembership.count).not.toHaveBeenCalled();
  });

  describe('against a limit of 5, counting 4', () => {
    beforeEach(() => {
      appRegisters(meter('reports', () => 4));
      mockLoadLimits.mockResolvedValue({ reports: 5 });
    });

    it('allows adding one by default, reporting used, limit and window', async () => {
      expect(await checkMeterQuota(ORG, 'reports', { now: NOW })).toEqual({
        allowed: true,
        used: 4,
        limit: 5,
        label: 'Label reports',
        window: { from: null, to: null },
      });
    });

    it('allows adding exactly up to the limit', async () => {
      expect((await checkMeterQuota(ORG, 'reports', { adding: 1 })).allowed).toBe(true);
    });

    it('refuses adding past the limit', async () => {
      expect((await checkMeterQuota(ORG, 'reports', { adding: 2 })).allowed).toBe(false);
    });

    it('allows adding 0 while within the limit', async () => {
      expect((await checkMeterQuota(ORG, 'reports', { adding: 0 })).allowed).toBe(true);
    });
  });

  it('allows adding 0 at the limit but refuses adding one more', async () => {
    appRegisters(meter('reports', () => 5));
    mockLoadLimits.mockResolvedValue({ reports: 5 });

    expect((await checkMeterQuota(ORG, 'reports', { adding: 0 })).allowed).toBe(true);
    expect((await checkMeterQuota(ORG, 'reports')).allowed).toBe(false);
  });

  it('refuses adding 0 when the org is already over the limit', async () => {
    appRegisters(meter('reports', () => 7));
    mockLoadLimits.mockResolvedValue({ reports: 5 });

    expect(await checkMeterQuota(ORG, 'reports', { adding: 0 })).toMatchObject({
      allowed: false,
      used: 7,
      limit: 5,
    });
  });

  it('refuses the first when the limit is 0', async () => {
    appRegisters(meter('reports', () => 0));
    mockLoadLimits.mockResolvedValue({ reports: 0 });

    expect(await checkMeterQuota(ORG, 'reports')).toMatchObject({
      allowed: false,
      used: 0,
      limit: 0,
    });
  });

  it('counts within the meter window and hands the count its bounds', async () => {
    const count = vi.fn().mockResolvedValue(1);
    appRegisters(meter('convos', count, 'month'));
    mockLoadLimits.mockResolvedValue({ convos: 10 });

    const check = await checkMeterQuota(ORG, 'convos', { now: NOW });

    expect(count).toHaveBeenCalledWith({
      orgId: ORG,
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
    });
    expect(check.window).toEqual({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
    });
  });

  it('refuses a seat when members plus invitations reach the seats limit', async () => {
    mockPrisma.orgMembership.count.mockResolvedValue(2);
    mockPrisma.verification.count.mockResolvedValue(1);
    mockLoadLimits.mockResolvedValue({ seats: 3 });

    expect(await checkMeterQuota(ORG, 'seats')).toMatchObject({
      allowed: false,
      used: 3,
      limit: 3,
      label: 'Seats',
    });
  });

  it('allows an unknown meter key, using the key as its label, and logs a warning', async () => {
    const check = await checkMeterQuota(ORG, 'nope');

    expect(check).toEqual({ allowed: true, used: null, limit: null, label: 'nope', window: null });
    expect(mockLoadLimits).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('nothing registers'),
      expect.objectContaining({ orgId: ORG, key: 'nope' })
    );
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('allows, without loading limits, when adding is %s, and logs', async (_what, adding) => {
    appRegisters(meter('reports', () => 100));
    mockLoadLimits.mockResolvedValue({ reports: 1 });

    const check = await checkMeterQuota(ORG, 'reports', { adding });

    expect(check).toMatchObject({ allowed: true, used: null, limit: null, label: 'Label reports' });
    expect(mockLoadLimits).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('whole number'),
      expect.objectContaining({ key: 'reports' })
    );
  });

  it('allows and logs an error when the limits cannot be loaded', async () => {
    const count = vi.fn();
    appRegisters(meter('reports', count));
    mockLoadLimits.mockRejectedValue(new Error('db down'));

    expect(await checkMeterQuota(ORG, 'reports')).toMatchObject({
      allowed: true,
      used: null,
      limit: null,
    });
    expect(count).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not read'),
      expect.objectContaining({ orgId: ORG, key: 'reports', error: 'db down' })
    );
  });

  it('allows when the org does not exist (limits null)', async () => {
    appRegisters(meter('reports', () => 100));
    mockLoadLimits.mockResolvedValue(null);

    expect((await checkMeterQuota(ORG, 'reports')).allowed).toBe(true);
  });

  it('allows, keeping the limit and a null used, when the count throws', async () => {
    appRegisters(
      meter('reports', () => {
        throw new Error('count broke');
      })
    );
    mockLoadLimits.mockResolvedValue({ reports: 1 });

    expect(await checkMeterQuota(ORG, 'reports')).toEqual({
      allowed: true,
      used: null,
      limit: 1,
      label: 'Label reports',
      window: null,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not be counted'),
      expect.objectContaining({ key: 'reports', error: 'count broke' })
    );
  });

  it('allows when an async count rejects', async () => {
    appRegisters(meter('reports', () => Promise.reject(new Error('plain string'))));
    mockLoadLimits.mockResolvedValue({ reports: 1 });

    expect((await checkMeterQuota(ORG, 'reports')).allowed).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'plain string' })
    );
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', NaN],
    ['a string', '3'],
    ['null', null],
  ])('allows with limit set and used null when the count answers %s', async (_what, answer) => {
    appRegisters(meter('reports', () => answer as never));
    mockLoadLimits.mockResolvedValue({ reports: 1 });

    expect(await checkMeterQuota(ORG, 'reports')).toMatchObject({
      allowed: true,
      used: null,
      limit: 1,
      window: null,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not be counted'),
      expect.objectContaining({ error: expect.stringContaining('whole number') })
    );
  });

  it('allows, without counting, when the window function throws', async () => {
    const count = vi.fn().mockResolvedValue(99);
    appRegisters(
      meter('reports', count, () => {
        throw new Error('no subscription');
      })
    );
    mockLoadLimits.mockResolvedValue({ reports: 1 });

    expect(await checkMeterQuota(ORG, 'reports')).toMatchObject({
      allowed: true,
      used: null,
      limit: 1,
    });
    expect(count).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not be counted'),
      expect.objectContaining({ error: 'no subscription' })
    );
  });
});

describe('meterLimitMessage', () => {
  it('names the limit and the meter label', () => {
    expect(meterLimitMessage({ label: 'Seats', limit: 3 })).toBe(
      "Your organisation has reached its limit of 3 for Seats. Ask whoever manages your organisation's account to raise it."
    );
  });

  it('reads a null limit as 0', () => {
    expect(meterLimitMessage({ label: 'Seats', limit: null })).toContain('limit of 0 for Seats');
  });
});

describe('refuseOverSeatsLimit', () => {
  it('never counts or loads limits for platform staff, even when the org is over', async () => {
    mockLoadLimits.mockResolvedValue({ seats: 1 });
    mockPrisma.orgMembership.count.mockResolvedValue(50);

    await expect(refuseOverSeatsLimit(ORG, { platformAdmin: true })).resolves.toBeUndefined();

    expect(mockLoadLimits).not.toHaveBeenCalled();
    expect(mockPrisma.orgMembership.count).not.toHaveBeenCalled();
  });

  it('throws a 403 with the meter_limit_reached details for an org admin at the limit', async () => {
    mockLoadLimits.mockResolvedValue({ seats: 3 });
    mockPrisma.orgMembership.count.mockResolvedValue(2);
    mockPrisma.verification.count.mockResolvedValue(1);

    const error = await refuseOverSeatsLimit(ORG, { platformAdmin: false }).catch((e) => e);

    expect(error).toBeInstanceOf(APIError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe(meterLimitMessage({ label: 'Seats', limit: 3 }));
    expect(error.details).toEqual({
      reason: METER_LIMIT_REASON,
      meter: 'seats',
      used: 3,
      limit: 3,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('refused a seat'),
      expect.objectContaining({ orgId: ORG, used: 3, limit: 3 })
    );
  });

  it('resolves when there is room for one more', async () => {
    mockLoadLimits.mockResolvedValue({ seats: 3 });
    mockPrisma.orgMembership.count.mockResolvedValue(1);
    mockPrisma.verification.count.mockResolvedValue(1);

    await expect(refuseOverSeatsLimit(ORG, { platformAdmin: false })).resolves.toBeUndefined();
  });

  it('resolves, counting nothing, when the org has no seats limit', async () => {
    await expect(refuseOverSeatsLimit(ORG, { platformAdmin: false })).resolves.toBeUndefined();
    expect(mockPrisma.orgMembership.count).not.toHaveBeenCalled();
  });

  it('refuses on an app seats count, which replaces the core one', async () => {
    appRegisters(meter('seats', () => 10));
    mockLoadLimits.mockResolvedValue({ seats: 10 });

    await expect(refuseOverSeatsLimit(ORG, { platformAdmin: false })).rejects.toMatchObject({
      status: 403,
      details: { used: 10, limit: 10 },
    });
    expect(mockPrisma.orgMembership.count).not.toHaveBeenCalled();
  });
});

describe('loadOrgMeterUsage', () => {
  it('is null for an org that does not exist', async () => {
    mockLoadLimits.mockResolvedValue(null);

    expect(await loadOrgMeterUsage(ORG, NOW)).toBeNull();
  });

  it('counts every meter even with no limit, and reports limit null', async () => {
    const count = vi.fn().mockResolvedValue(7);
    appRegisters(meter('reports', count, 'month'));
    mockPrisma.orgMembership.count.mockResolvedValue(2);

    const result = await loadOrgMeterUsage(ORG, NOW);

    expect(count).toHaveBeenCalledOnce();
    expect(result!.unregistered).toEqual({});
    expect(result!.meters).toEqual([
      expect.objectContaining({
        key: 'seats',
        core: true,
        period: 'standing',
        limit: null,
        used: 2,
        countFailed: false,
      }),
      {
        key: 'reports',
        label: 'Label reports',
        description: 'Desc reports',
        period: 'month',
        core: false,
        limit: null,
        used: 7,
        window: {
          from: new Date('2026-03-01T00:00:00.000Z'),
          to: new Date('2026-04-01T00:00:00.000Z'),
        },
        countFailed: false,
      },
    ]);
  });

  it('marks a meter whose count fails and still counts the others', async () => {
    appRegisters(
      meter('broken', () => {
        throw new Error('nope');
      })
    );
    mockPrisma.orgMembership.count.mockResolvedValue(3);
    mockLoadLimits.mockResolvedValue({ broken: 2, seats: 5 });

    const result = await loadOrgMeterUsage(ORG, NOW);

    expect(result!.meters[0]).toMatchObject({
      key: 'seats',
      used: 3,
      limit: 5,
      countFailed: false,
    });
    expect(result!.meters[1]).toMatchObject({
      key: 'broken',
      used: null,
      window: null,
      limit: 2,
      countFailed: true,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('admin page'),
      expect.objectContaining({ key: 'broken', error: 'nope' })
    );
  });

  it('marks a bad count answer as failed too', async () => {
    appRegisters(meter('odd', () => 1.5));

    const result = await loadOrgMeterUsage(ORG, NOW);

    expect(result!.meters.find((m) => m.key === 'odd')).toMatchObject({
      used: null,
      countFailed: true,
    });
  });

  it('returns limits for keys nothing registers apart, in unregistered', async () => {
    mockLoadLimits.mockResolvedValue({ seats: 4, retired: 9, gone: 0 });

    const result = await loadOrgMeterUsage(ORG, NOW);

    expect(result!.unregistered).toEqual({ retired: 9, gone: 0 });
    expect(result!.meters.map((m) => m.key)).toEqual(['seats']);
  });

  it('reports period custom for a function period and passes now to it', async () => {
    const period = vi.fn().mockReturnValue({
      from: new Date('2026-03-10T00:00:00Z'),
      to: new Date('2026-04-10T00:00:00Z'),
    });
    appRegisters(meter('cycle', () => 1, period));

    const result = await loadOrgMeterUsage(ORG, NOW);

    expect(result!.meters.find((m) => m.key === 'cycle')).toMatchObject({
      period: 'custom',
      used: 1,
    });
    expect(period).toHaveBeenCalledWith({ orgId: ORG, now: NOW });
  });
});
