/**
 * Unit Tests: GET/PATCH /api/v1/admin/orgs/[id]/meters (§135 t-1035)
 *
 * Real `withAdminAuth`, the real meter registry, the real `meters.ts` counts
 * and the real `writeOrgMeterLimits`, over a mocked Prisma whose
 * `$transaction` runs the callback against the same mock; the app's meters
 * come from a mocked `lib/app/entitlements.ts`. Pins: platform-admin only; at
 * `multi`, written only from the install org or an unbound admin API key,
 * refused before the body is read; a PATCH naming only the limits it changes;
 * a limit on a key nothing registers refused, while `null` clears a kept one;
 * the 409/404 outcomes; and an audit row naming what was replaced, written
 * only when something changed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { SHARED_SETTINGS_REFUSAL_CODE } from '@/lib/tenancy/shared-settings';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const mockResolveApiKey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  resolveApiKey: mockResolveApiKey,
}));

const mockPrisma = vi.hoisted(() => {
  const db = {
    org: { findUnique: vi.fn(), update: vi.fn() },
    orgMembership: { findUnique: vi.fn(), count: vi.fn() },
    verification: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  return db;
});
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

const mockLogAdminAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: mockLogAdminAction,
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));

import { GET, PATCH } from '@/app/api/v1/admin/orgs/[id]/meters/route';
import { initAppEntitlements } from '@/lib/app/entitlements';
import { __resetEntitlementRegistryForTests, registerMeter } from '@/lib/tenancy/entitlements';
import { createMockAuthSession } from '@/tests/helpers/auth';

const OTHER = 'cmorg000000000000000other';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null = INSTALL_ORG_ID) {
  const base = createMockAuthSession();
  return {
    ...base,
    session: { ...base.session, activeOrgId },
    user: { ...base.user, role },
  };
}

const URL_FOR = (id: string) => `http://localhost/api/v1/admin/orgs/${id}/meters`;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = OTHER) => GET(new Request(URL_FOR(id)) as unknown as NextRequest, ctx(id));
const patch = (body: unknown, id = OTHER) =>
  PATCH(
    new Request(URL_FOR(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    ctx(id)
  );

async function json(res: Response) {
  return JSON.parse(await res.text()) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message?: string; details?: Record<string, unknown> };
  };
}

function registerAppMeter() {
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerMeter({
      key: 'convos',
      label: 'Conversations',
      description: 'Conversations this month.',
      period: 'month',
      count: () => 7,
    });
  });
}

/** The settings the last write stored. */
function storedSettings() {
  const call = mockPrisma.org.update.mock.calls.at(-1) as
    [{ data: { settings: unknown } }] | undefined;
  return call?.[0].data.settings;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  __resetEntitlementRegistryForTests();
  vi.mocked(initAppEntitlements).mockImplementation(() => {});
  registerAppMeter();
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
  mockResolveApiKey.mockResolvedValue(null);
  mockGetSession.mockResolvedValue(session('ADMIN'));
  mockPrisma.org.findUnique.mockResolvedValue({
    settings: { providers: { approved: ['id-anthropic'] } },
  });
  mockPrisma.orgMembership.findUnique.mockResolvedValue({
    role: 'OWNER',
    org: { status: 'ACTIVE' },
  });
  mockPrisma.orgMembership.count.mockResolvedValue(3);
  mockPrisma.verification.findMany.mockResolvedValue(
    [1, 2].map(() => ({
      metadata: {
        name: 'Invitee',
        role: 'USER',
        invitedBy: 'cmuser000000000000000adm1',
        invitedAt: '2026-03-01T00:00:00.000Z',
        orgId: OTHER,
      },
    }))
  );
  mockPrisma.org.update.mockResolvedValue({});
});

describe('GET /api/v1/admin/orgs/[id]/meters', () => {
  it('reports each meter with its limit and a count the route took from the data', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { quotas: { meters: { seats: 10, retired: 4 } } },
    });

    const res = await get();
    const data = (await json(res)).data!;

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ orgId: OTHER, mayChange: true, registrationFailed: false });
    expect(data.meters).toEqual([
      expect.objectContaining({
        key: 'seats',
        core: true,
        limit: 10,
        // 3 non-staff members + 2 pending invitations
        used: 5,
        countFailed: false,
      }),
      expect.objectContaining({
        key: 'convos',
        core: false,
        limit: null,
        used: 7,
        period: 'month',
      }),
    ]);
    // A stored limit for a key nothing registers is reported apart.
    expect(data.unregistered).toEqual({ retired: 4 });
  });

  it('says the app registration failed, rather than looking like an install with no meter', async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('boom');
    });

    const data = (await json(await get())).data!;

    expect(data.registrationFailed).toBe(true);
    // Only the platform's own seats meter is left.
    expect((data.meters as Array<{ key: string }>).map((m) => m.key)).toEqual(['seats']);
  });

  it('is a 404 for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    expect((await get()).status).toBe(404);
  });

  it('refuses a user who is not a platform admin', async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER));

    expect((await get()).status).toBe(403);
  });

  it('lets a platform admin in a customer org read them, saying they cannot be changed from there', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    const res = await get();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual(expect.objectContaining({ mayChange: false }));
  });
});

describe('PATCH /api/v1/admin/orgs/[id]/meters', () => {
  it('stores the named limit beside the other settings and audits what it replaced', async () => {
    const res = await patch({ limits: { seats: 10 } });

    expect(res.status).toBe(200);
    expect(storedSettings()).toEqual({
      providers: { approved: ['id-anthropic'] },
      quotas: { meters: { seats: 10 } },
    });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.meters.update',
        entityType: 'org',
        entityId: OTHER,
        actingOrgId: OTHER,
        changes: { meterLimits: { from: null, to: { seats: 10 } } },
      })
    );
  });

  it('leaves a limit it does not name as it is, and records both sides', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { quotas: { meters: { seats: 10, convos: 50 } } },
    });

    await patch({ limits: { seats: 12 } });

    expect(storedSettings()).toEqual({ quotas: { meters: { seats: 12, convos: 50 } } });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: {
          meterLimits: {
            from: { seats: 10, convos: 50 },
            to: { seats: 12, convos: 50 },
          },
        },
      })
    );
  });

  it('keeps the org caps beside the limits it writes', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { quotas: { monthlyBudgetUsd: 25 } },
    });

    await patch({ limits: { seats: 4 } });

    expect(storedSettings()).toEqual({ quotas: { monthlyBudgetUsd: 25, meters: { seats: 4 } } });
  });

  it('clears a limit with null, records `to` as null when none is left, and reports it cleared', async () => {
    // The write reads the stored limits; the response then re-reads the org.
    mockPrisma.org.findUnique
      .mockResolvedValueOnce({ settings: { quotas: { meters: { seats: 10 } } } })
      .mockResolvedValue({ settings: null });

    const res = await patch({ limits: { seats: null } });

    expect(res.status).toBe(200);
    // Nothing left in the quotas slice, so the slice is removed.
    expect(storedSettings()).toBe(Prisma.DbNull);
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: { meterLimits: { from: { seats: 10 }, to: null } },
      })
    );
    const meters = (await json(res)).data!.meters as Array<{ key: string; limit: number | null }>;
    expect(meters.find((m) => m.key === 'seats')?.limit).toBeNull();
  });

  it('lets null clear a kept limit for a key nothing registers, and leaves the rest', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { quotas: { meters: { seats: 10, retired: 4 } } },
    });

    const res = await patch({ limits: { retired: null } });

    expect(res.status).toBe(200);
    expect(storedSettings()).toEqual({ quotas: { meters: { seats: 10 } } });
  });

  it('refuses a limit on a key nothing registers, naming it, and writes nothing', async () => {
    const res = await patch({ limits: { seats: 5, repots: 3 } });
    const body = await json(res);

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.details?.unknownMeters).toEqual(['repots']);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('says the app registration failed, rather than that the key does not exist', async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await patch({ limits: { convos: 100 } });
    const body = await json(res);

    expect(res.status).toBe(409);
    expect(body.error?.code).toBe('CONFLICT');
    expect(body.error?.message).toMatch(/failed to register/);
    expect(body.error?.details?.unknownMeters).toEqual(['convos']);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('audits the stored limits as they were when a save tidies one the read could not use', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { quotas: { meters: { seats: 10, broken: -1 } } },
    });

    const res = await patch({ limits: { seats: 10 } });

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: { meterLimits: { from: { seats: 10, broken: -1 }, to: { seats: 10 } } },
      })
    );
  });

  it.each([
    ['empty limits', { limits: {} }],
    ['a negative limit', { limits: { seats: -1 } }],
    ['a non-integer limit', { limits: { seats: 1.5 } }],
    ['a limit that is not a number', { limits: { seats: '5' } }],
    ['a malformed key', { limits: { 'Bad-Key': 5 } }],
    ['an extra top-level key', { limits: { seats: 5 }, extra: true }],
    ['no limits', {}],
  ])('rejects %s with a 400 and writes nothing', async (_label, body) => {
    const res = await patch(body);

    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('writes and records nothing for a save that changes nothing', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { quotas: { meters: { seats: 10 } } },
    });

    const res = await patch({ limits: { seats: 10 } });

    expect(res.status).toBe(200);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing changed, so nothing written
    expect(mockLogAdminAction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing changed, so nothing to audit
  });

  it('is a 409 when another settings write landed first, recording nothing', async () => {
    mockPrisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'x' })
    );

    const res = await patch({ limits: { seats: 5 } });

    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe('CONFLICT');
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('does not turn another database failure into a 409', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('db down'));

    const res = await patch({ limits: { seats: 5 } });

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('is a 404 for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    expect((await patch({ limits: { seats: 5 } })).status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("refuses an org's own admin, so it cannot raise its own limits", async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER));

    const res = await patch({ limits: { seats: 500 } });

    expect(res.status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });
});

describe('the limits at multi are changed only from the install org, as the caps are', () => {
  it('refuses a platform admin in a customer org with the shared reason, writing nothing', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    const res = await patch({ limits: { seats: 5 } });
    const body = await json(res);

    expect(res.status).toBe(403);
    expect(body.error?.code).toBe('FORBIDDEN');
    expect(body.error?.details?.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
    expect(body.error?.message).toMatch(/install organisation/);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'tenancy: refused an org meter limits write outside the install org',
      expect.objectContaining({ orgId: OTHER, activeOrgId: OTHER })
    );
  });

  it('refuses before reading the body, so a bad one is not what the caller is told to fix', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    // Would be a 400 (and an unregistered key) from the install org.
    const res = await patch({ limits: { 'Bad-Key': -1 } });

    expect(res.status).toBe(403);
    expect((await json(res)).error?.details?.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
  });

  it('lets an unbound admin API key set them, as the install org', async () => {
    mockGetSession.mockResolvedValue(null);
    mockResolveApiKey.mockResolvedValue({
      session: session('ADMIN', null),
      scopes: ['admin'],
      rateLimitRpm: null,
      orgId: null,
      ownerAccountType: 'HUMAN',
    });

    const res = await patch({ limits: { seats: 5 } });

    expect(res.status).toBe(200);
    expect(storedSettings()).toMatchObject({ quotas: { meters: { seats: 5 } } });
  });

  it('refuses a key bound to a customer org, which runs inside it', async () => {
    mockGetSession.mockResolvedValue(null);
    mockResolveApiKey.mockResolvedValue({
      session: session('ADMIN', null),
      scopes: ['admin'],
      rateLimitRpm: null,
      orgId: OTHER,
      ownerAccountType: 'HUMAN',
    });

    expect((await patch({ limits: { seats: 5 } })).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('lets a platform admin in a customer org set them at single, where there is only one org', async () => {
    mockEnv.TENANCY_MODE = 'single';
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    const res = await patch({ limits: { seats: 5 } });

    expect(res.status).toBe(200);
    expect(mockPrisma.org.update).toHaveBeenCalledTimes(1);
  });
});
