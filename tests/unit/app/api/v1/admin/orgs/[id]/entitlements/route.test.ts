/**
 * Unit Tests: GET/PUT /api/v1/admin/orgs/[id]/entitlements (§135 t-1033)
 *
 * Real `withAdminAuth`, the real registry and the real `writeOrgEntitlements`,
 * over a mocked Prisma whose `$transaction` runs the callback against the same
 * mock; the app's switches come from a mocked `lib/app/entitlements.ts`. Pins:
 * platform-admin only (an org's own admin is refused, so it cannot grant itself
 * what it has not bought), the key required, an unregistered key refused, a
 * replace keeping every other `settings` key and every stored key nothing
 * registers, `null` clearing back to nothing set, the 409s, and an audit row
 * naming what was replaced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const mockPrisma = vi.hoisted(() => {
  const db = {
    org: { findUnique: vi.fn(), update: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
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

import { GET, PUT } from '@/app/api/v1/admin/orgs/[id]/entitlements/route';
import { initAppEntitlements } from '@/lib/app/entitlements';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';
import { createMockAuthSession } from '@/tests/helpers/auth';

const OTHER = 'cmorg000000000000000other';

function session(role: 'USER' | 'ADMIN', activeOrgId: string = INSTALL_ORG_ID) {
  const base = createMockAuthSession();
  return {
    ...base,
    session: { ...base.session, activeOrgId },
    user: { ...base.user, role },
  };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = OTHER) =>
  GET(
    new Request(`http://localhost/api/v1/admin/orgs/${id}/entitlements`) as unknown as NextRequest,
    ctx(id)
  );
const put = (body: unknown, id = OTHER) =>
  PUT(
    new Request(`http://localhost/api/v1/admin/orgs/${id}/entitlements`, {
      method: 'PUT',
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

function registerSwitches() {
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: 'Build reports.' });
    registerEntitlementSwitch({
      key: 'leads',
      label: 'Lead generation',
      description: 'Funnels and leads.',
      whenNothingSet: true,
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
  __resetEntitlementRegistryForTests();
  vi.mocked(initAppEntitlements).mockImplementation(() => {});
  registerSwitches();
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
  mockPrisma.aiApiKey.findFirst.mockResolvedValue(null);
  mockGetSession.mockResolvedValue(session('ADMIN'));
  mockPrisma.org.findUnique.mockResolvedValue({
    settings: { providers: { approved: ['id-anthropic'] } },
  });
  mockPrisma.orgMembership.findUnique.mockResolvedValue({
    role: 'OWNER',
    org: { status: 'ACTIVE' },
  });
  mockPrisma.org.update.mockResolvedValue({});
});

describe('GET /api/v1/admin/orgs/[id]/entitlements', () => {
  it('reports an org nothing was set on, with each switch at its default', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({
      orgId: OTHER,
      nothingSet: true,
      unreadable: false,
      switches: [
        {
          key: 'reports',
          label: 'Reports',
          description: 'Build reports.',
          whenNothingSet: false,
          on: false,
        },
        {
          key: 'leads',
          label: 'Lead generation',
          description: 'Funnels and leads.',
          whenNothingSet: true,
          on: true,
        },
      ],
      unregistered: [],
    });
  });

  it('reports a set org as set, naming stored keys nothing registers', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { switches: ['reports', 'retired'] } },
    });

    const data = (await json(await get())).data!;

    expect(data.nothingSet).toBe(false);
    expect(data.switches).toEqual([
      expect.objectContaining({ key: 'reports', on: true }),
      expect.objectContaining({ key: 'leads', on: false }),
    ]);
    expect(data.unregistered).toEqual(['retired']);
  });

  it('says a slice it cannot read is unreadable, with nothing on', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ settings: { entitlements: 'garbage' } });

    const data = (await json(await get())).data!;

    expect(data).toMatchObject({ nothingSet: false, unreadable: true });
    expect(data.switches).toEqual([
      expect.objectContaining({ key: 'reports', on: false }),
      expect.objectContaining({ key: 'leads', on: false }),
    ]);
  });

  it('is a 404 for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    expect((await get()).status).toBe(404);
  });

  it('refuses a user who is not a platform admin', async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER));

    expect((await get()).status).toBe(403);
  });
});

describe('PUT /api/v1/admin/orgs/[id]/entitlements', () => {
  it('stores the switches that are on, keeping every other settings key, and audits it', async () => {
    const res = await put({ switches: ['reports'] });

    expect(res.status).toBe(200);
    expect(storedSettings()).toEqual({
      providers: { approved: ['id-anthropic'] },
      entitlements: { switches: ['reports'] },
    });
    expect((await json(res)).data).toMatchObject({ nothingSet: false, unregistered: [] });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.entitlements.replace',
        entityType: 'org',
        entityId: OTHER,
        actingOrgId: OTHER,
        changes: {
          entitlements: { from: { nothingSet: true }, to: { switches: ['reports'] } },
        },
      })
    );
  });

  it('stores an empty set as set, so a default-on switch is off for this org', async () => {
    const res = await put({ switches: [] });

    expect(storedSettings()).toEqual({
      providers: { approved: ['id-anthropic'] },
      entitlements: { switches: [] },
    });
    const data = (await json(res)).data!;
    expect(data.nothingSet).toBe(false);
    expect(data.switches).toEqual([
      expect.objectContaining({ key: 'reports', on: false }),
      expect.objectContaining({ key: 'leads', on: false }),
    ]);
  });

  it('keeps stored keys nothing registers, which the caller could not see', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { switches: ['leads', 'retired'] } },
    });

    await put({ switches: ['reports'] });

    expect(storedSettings()).toEqual({ entitlements: { switches: ['reports', 'retired'] } });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: {
          entitlements: {
            from: { switches: ['leads', 'retired'] },
            to: { switches: ['reports', 'retired'] },
          },
        },
      })
    );
  });

  it('clears the org back to nothing set for null', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { switches: [] }, providers: { approved: [] } },
    });

    const res = await put({ switches: null });

    expect(storedSettings()).toEqual({ providers: { approved: [] } });
    expect((await json(res)).data).toMatchObject({ nothingSet: true });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: { entitlements: { from: { switches: [] }, to: { nothingSet: true } } },
      })
    );
  });

  it('refuses a key no app registers, naming it, and writes nothing', async () => {
    const res = await put({ switches: ['reports', 'repots'] });
    const body = await json(res);

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.details?.unknownSwitches).toEqual(['repots']);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('refuses a body that leaves the key out, so a replace cannot clear an org by omission', async () => {
    const res = await put({});

    expect(res.status).toBe(400);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('is a 409 when no app registers a switch: there is nothing to set', async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {});

    const res = await put({ switches: [] });

    expect(res.status).toBe(409);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('is a 409 when another settings write landed first, writing nothing', async () => {
    const { Prisma } = await import('@prisma/client');
    mockPrisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'x' })
    );

    const res = await put({ switches: ['reports'] });

    expect(res.status).toBe(409);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('is a 404 for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    expect((await put({ switches: ['reports'] })).status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("refuses an org's own admin, so it cannot grant itself what it has not bought", async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER));
    mockPrisma.orgMembership.findUnique.mockResolvedValue({
      role: 'OWNER',
      org: { status: 'ACTIVE' },
    });

    const res = await put({ switches: ['reports'] });

    expect(res.status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });
});
