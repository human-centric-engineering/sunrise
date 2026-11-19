/**
 * Unit Tests: GET/PATCH /api/v1/orgs/[id]/entitlements (§135 t-1054)
 *
 * Real `withAuth`, the real default policy, the real registry and the real
 * `setOrgSwitches`, over a mocked Prisma. Pins: an org's own admin, acting in
 * it, sees and sets the switches the app registers `setBy: 'org'`, audited;
 * a switch registered without `setBy` stays platform-only and naming it is a
 * 403, writing nothing; another org's switches are refused; a member who is
 * not an admin is refused by the policy; an API key and a support session
 * cannot write; and a stored slice that could not be read is refused rather
 * than written over, so an org's save never closes what it bought.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

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

// The support session is the tenant context's; stood in for here.
const support = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/auth/support-principal', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/support-principal')>();
  return {
    ...real,
    isSupportEntry: (entry: { source: string } | null | undefined) =>
      support.on || real.isSupportEntry(entry),
  };
});

const mockPrisma = vi.hoisted(() => {
  const db = {
    org: { findUnique: vi.fn(), update: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
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

import { GET, PATCH } from '@/app/api/v1/orgs/[id]/entitlements/route';
import { initAppEntitlements } from '@/lib/app/entitlements';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';
import { createMockAuthSession } from '@/tests/helpers/auth';
import { API_KEY_SESSION_ID_PREFIX } from '@/lib/auth/api-keys';

const ORG = 'cmorg000000000000000acme1';
const OTHER = 'cmorg000000000000000other';

function session(activeOrgId: string = ORG) {
  const base = createMockAuthSession();
  return {
    ...base,
    session: { ...base.session, activeOrgId },
    user: { ...base.user, role: 'USER' },
  };
}

const URL_FOR = (id: string) => `http://localhost/api/v1/orgs/${id}/entitlements`;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = ORG) => GET(new Request(URL_FOR(id)) as unknown as NextRequest, ctx(id));
const patch = (body: unknown, id = ORG) =>
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
    data?: { switches: { key: string; on: boolean }[]; mayChange: boolean; unreadable: boolean };
    error?: { code: string; message?: string; details?: Record<string, unknown> };
  };
}

/** One switch an org bought (no `setBy`), and one its admins may set. */
function registerSwitches() {
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: 'Bought.' });
    registerEntitlementSwitch({
      key: 'beta_editor',
      label: 'New editor (beta)',
      description: 'Try the new editor.',
      setBy: 'org',
    });
  });
}

/** What the org stores; the resolver's row and the settings read share the mock. */
function orgStores(settings: unknown) {
  mockPrisma.org.findUnique.mockResolvedValue({ id: ORG, settings });
}

function orgRole(role: 'OWNER' | 'ADMIN' | 'MEMBER') {
  mockPrisma.orgMembership.findUnique.mockResolvedValue({ role, org: { status: 'ACTIVE' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  support.on = false;
  mockEnv.TENANCY_MODE = 'multi';
  __resetEntitlementRegistryForTests();
  registerSwitches();
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
  mockResolveApiKey.mockResolvedValue(null);
  mockGetSession.mockResolvedValue(session());
  orgRole('ADMIN');
  orgStores({});
  mockPrisma.org.update.mockResolvedValue({});
});

describe('GET (t-1054)', () => {
  it("lists only the switches the org's admins may set, to an org admin acting in it", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data?.switches.map((s) => s.key)).toEqual(['beta_editor']);
    expect(body.data?.mayChange).toBe(true);
  });

  it('refuses a member who is not an admin, by the policy', async () => {
    orgRole('MEMBER');
    expect((await get()).status).toBe(403);
  });

  it('refuses another org, even to an admin of their own', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ id: OTHER, settings: {} });
    expect((await get(OTHER)).status).toBe(403);
  });

  it('lets a support session read, but not change', async () => {
    support.on = true;
    const body = await json(await get());
    expect(body.data?.mayChange).toBe(false);
  });
});

describe('PATCH (t-1054)', () => {
  it("sets an 'org' switch on the org's own org, and audits it", async () => {
    const res = await patch({ on: ['beta_editor'], off: [] });
    expect(res.status).toBe(200);
    expect(mockPrisma.org.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ORG },
        data: { settings: { entitlements: { on: ['beta_editor'], off: [] } } },
      })
    );
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.entitlements.update',
        entityId: ORG,
        actingOrgId: ORG,
        metadata: { setBy: 'org', on: ['beta_editor'], off: [] },
        changes: {
          entitlements: { from: null, to: { on: ['beta_editor'], off: [] } },
        },
      })
    );
    expect((await json(res)).data?.switches).toEqual([
      expect.objectContaining({ key: 'beta_editor', on: true }),
    ]);
  });

  it('refuses a switch registered without setBy, writing nothing', async () => {
    const res = await patch({ on: ['reports', 'beta_editor'], off: [] });
    expect(res.status).toBe(403);
    expect((await json(res)).error?.details).toEqual({
      reason: 'switch_set_by_platform',
      switches: ['reports'],
    });
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — a refused write writes nothing;
    expect(mockLogAdminAction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing changed, nothing audited;
  });

  it("refuses setting another org's switches", async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ id: OTHER, settings: {} });
    expect((await patch({ on: ['beta_editor'], off: [] }, OTHER)).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused before the write;
  });

  it('refuses a member who is not an admin', async () => {
    orgRole('MEMBER');
    expect((await patch({ on: ['beta_editor'], off: [] })).status).toBe(403);
  });

  it('refuses a support session', async () => {
    support.on = true;
    expect((await patch({ on: ['beta_editor'], off: [] })).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused before the write;
  });

  it('refuses an unregistered key as a 400', async () => {
    expect((await patch({ on: ['typo'], off: [] })).status).toBe(400);
  });

  it('refuses to write over a stored slice it cannot read, rather than close what the org bought', async () => {
    orgStores({ entitlements: 'broken' });
    const res = await patch({ on: ['beta_editor'], off: [] });
    expect(res.status).toBe(409);
    expect((await json(res)).error?.details).toEqual({ reason: 'switches_unreadable' });
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused inside the transaction;
  });

  it('answers 409 when no switch is org-set: the default install', async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
    });
    expect((await patch({ on: ['reports'], off: [] })).status).toBe(409);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to set;
  });

  it('keeps what platform staff set when the org sets its own', async () => {
    orgStores({ entitlements: { on: ['reports'], off: [] }, quotas: { monthlyBudgetUsd: 5 } });
    await patch({ on: [], off: ['beta_editor'] });
    expect(mockPrisma.org.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          settings: {
            entitlements: { on: ['reports'], off: ['beta_editor'] },
            quotas: { monthlyBudgetUsd: 5 },
          },
        },
      })
    );
  });
});

describe('the remaining refusals and answers (t-1054)', () => {
  it('refuses a platform admin for an org they are not acting in: they use the platform route', async () => {
    const admin = session(ORG);
    mockGetSession.mockResolvedValue({ ...admin, user: { ...admin.user, role: 'ADMIN' } });
    mockPrisma.org.findUnique.mockResolvedValue({ id: OTHER, settings: {} });
    const res = await get(OTHER);
    expect(res.status).toBe(403);
    expect((await json(res)).error?.message).toBe(
      'Switch to this organisation to see or change its switches'
    );
  });

  it('refuses an admin API key: setting them is a person’s choice', async () => {
    const admin = session(ORG);
    mockResolveApiKey.mockResolvedValue({
      session: {
        ...admin,
        session: { ...admin.session, id: `${API_KEY_SESSION_ID_PREFIX}key_1` },
        user: { ...admin.user, role: 'ADMIN' },
      },
      scopes: ['admin'],
      rateLimitRpm: null,
      // Unbound: a key bound to an org is refused before the handler runs.
      orgId: null,
      ownerAccountType: 'HUMAN',
    });
    const res = await patch({ on: ['beta_editor'], off: [] });
    expect(res.status).toBe(403);
    expect((await json(res)).error?.message).toContain('browser session');
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused before the write;
  });

  it('answers 409 on a clash with another settings write, auditing nothing', async () => {
    const { Prisma } = await import('@prisma/client');
    mockPrisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'x' })
    );
    expect((await patch({ on: ['beta_editor'], off: [] })).status).toBe(409);
    expect(mockLogAdminAction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing landed;
  });

  it('writes and audits nothing when the change leaves the org as it is', async () => {
    orgStores({ entitlements: { on: ['beta_editor'], off: [] } });
    const res = await patch({ on: ['beta_editor'], off: [] });
    expect(res.status).toBe(200);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to write;
    expect(mockLogAdminAction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing changed;
  });

  it("says so when the app's switches failed to register", async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('broken init');
    });
    const res = await patch({ on: ['beta_editor'], off: [] });
    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toContain('failed to register');
  });
});
