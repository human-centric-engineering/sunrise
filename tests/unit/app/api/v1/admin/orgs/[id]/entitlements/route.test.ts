/**
 * Unit Tests: GET/PATCH/DELETE /api/v1/admin/orgs/[id]/entitlements (§135 t-1033)
 *
 * Real `withAdminAuth`, the real registry and the real `setOrgSwitches`, over
 * a mocked Prisma whose `$transaction` runs the callback against the same
 * mock; the app's switches come from a mocked `lib/app/entitlements.ts`. Pins:
 * platform-admin only (an org's own admin is refused, so it cannot grant itself
 * what it has not bought), and at `multi` written only from the install org or
 * an unbound admin API key, as the caps are; a PATCH setting only the switches
 * it names, so a switch the caller did not know about is left alone; a DELETE
 * putting every registered switch back to its default; every other `settings`
 * key and every stored key nothing registers kept; an unregistered key
 * refused; the 409s; and an audit row naming what was replaced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
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

import { DELETE, GET, PATCH } from '@/app/api/v1/admin/orgs/[id]/entitlements/route';
import { initAppEntitlements } from '@/lib/app/entitlements';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';
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

const URL_FOR = (id: string) => `http://localhost/api/v1/admin/orgs/${id}/entitlements`;
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
const reset = (id = OTHER) =>
  DELETE(new Request(URL_FOR(id), { method: 'DELETE' }) as unknown as NextRequest, ctx(id));

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
  mockEnv.TENANCY_MODE = 'multi';
  __resetEntitlementRegistryForTests();
  vi.mocked(initAppEntitlements).mockImplementation(() => {});
  registerSwitches();
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
      mayChange: true,
      registrationFailed: false,
      switches: [
        {
          key: 'reports',
          label: 'Reports',
          description: 'Build reports.',
          whenNothingSet: false,
          on: false,
          atDefault: true,
        },
        {
          key: 'leads',
          label: 'Lead generation',
          description: 'Funnels and leads.',
          whenNothingSet: true,
          on: true,
          atDefault: true,
        },
      ],
      unregistered: [],
    });
  });

  it('reports a set org as set, naming stored keys nothing registers', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['reports', 'retired'], off: ['leads'] } },
    });

    const data = (await json(await get())).data!;

    expect(data.nothingSet).toBe(false);
    expect(data.switches).toEqual([
      expect.objectContaining({ key: 'reports', on: true, atDefault: false }),
      expect.objectContaining({ key: 'leads', on: false, atDefault: false }),
    ]);
    expect(data.unregistered).toEqual(['retired']);
  });

  it('reports a switch registered since the org was saved at its default', async () => {
    // Saved before `leads` was registered: only `reports` was set.
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['reports'], off: [] } },
    });

    const data = (await json(await get())).data!;

    expect(data.nothingSet).toBe(false);
    expect(data.switches).toEqual([
      expect.objectContaining({ key: 'reports', on: true, atDefault: false }),
      expect.objectContaining({ key: 'leads', on: true, atDefault: true }),
    ]);
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

  it('says the app registration failed, rather than looking like an install with no switch', async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('boom');
    });

    const data = (await json(await get())).data!;

    expect(data).toMatchObject({ registrationFailed: true, switches: [] });
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

describe('PATCH /api/v1/admin/orgs/[id]/entitlements', () => {
  it('sets the named switches on and off, keeping other settings keys, and audits it', async () => {
    const res = await patch({ on: ['reports'], off: ['leads'] });

    expect(res.status).toBe(200);
    expect(storedSettings()).toEqual({
      providers: { approved: ['id-anthropic'] },
      entitlements: { on: ['reports'], off: ['leads'] },
    });
    expect((await json(res)).data).toMatchObject({
      nothingSet: false,
      mayChange: true,
      unregistered: [],
    });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.entitlements.update',
        entityType: 'org',
        entityId: OTHER,
        actingOrgId: OTHER,
        changes: {
          entitlements: {
            from: { on: [], off: [] },
            to: { on: ['reports'], off: ['leads'] },
          },
        },
      })
    );
  });

  it('leaves a switch it does not name as it is, so a stale form cannot turn it off', async () => {
    // The form loaded before `leads` was registered, so it names only `reports`.
    const res = await patch({ on: [], off: ['reports'] });

    expect(storedSettings()).toEqual({
      providers: { approved: ['id-anthropic'] },
      entitlements: { on: [], off: ['reports'] },
    });
    expect((await json(res)).data!.switches).toEqual([
      expect.objectContaining({ key: 'reports', on: false, atDefault: false }),
      expect.objectContaining({ key: 'leads', on: true, atDefault: true }),
    ]);
  });

  it('stores every switch set off as off, so a default-on switch is off for this org', async () => {
    const res = await patch({ on: [], off: ['leads', 'reports'] });

    expect(storedSettings()).toEqual({
      providers: { approved: ['id-anthropic'] },
      entitlements: { on: [], off: ['leads', 'reports'] },
    });
    expect((await json(res)).data!.switches).toEqual([
      expect.objectContaining({ key: 'reports', on: false }),
      expect.objectContaining({ key: 'leads', on: false }),
    ]);
  });

  it('keeps values stored for keys nothing registers, on and off, which the caller could not see', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['leads', 'retired'], off: ['older'] } },
    });

    await patch({ on: ['reports'], off: ['leads'] });

    expect(storedSettings()).toEqual({
      entitlements: { on: ['reports', 'retired'], off: ['leads', 'older'] },
    });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: {
          entitlements: {
            from: { on: ['leads', 'retired'], off: ['older'] },
            to: { on: ['reports', 'retired'], off: ['leads', 'older'] },
          },
        },
      })
    );
  });

  it('writes and records nothing for a save that changes nothing', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['reports'], off: ['leads'] } },
    });

    const res = await patch({ on: ['reports'], off: ['leads'] });

    expect(res.status).toBe(200);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing changed, so nothing written
    expect(mockLogAdminAction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing changed, so nothing to audit
  });

  it('keeps an unreadable slice’s keys in the audit row, so a carried key is not read as granted', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: ['old_pkg', 'reports'] } },
    });

    await patch({ on: [], off: ['reports', 'leads'] });

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: {
          entitlements: {
            from: { unreadable: true, on: ['old_pkg', 'reports'], off: [] },
            to: { on: [], off: ['leads', 'old_pkg', 'reports'] },
          },
        },
      })
    );
  });

  it('counts repeated keys once against the limit', async () => {
    const res = await patch({ on: Array.from({ length: 150 }, () => 'reports'), off: [] });

    expect(res.status).toBe(200);
    expect(storedSettings()).toMatchObject({ entitlements: { on: ['reports'], off: [] } });
  });

  it('refuses a key no app registers, naming it, and writes nothing', async () => {
    const res = await patch({ on: ['reports'], off: ['repots'] });
    const body = await json(res);

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.details?.unknownSwitches).toEqual(['repots']);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('refuses a switch named both on and off, and a body missing either list', async () => {
    expect((await patch({ on: ['reports'], off: ['reports'] })).status).toBe(400);
    expect((await patch({ on: ['reports'] })).status).toBe(400);
    expect((await patch({ switches: ['reports'] })).status).toBe(400);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('is a 409 when no app registers a switch: there is nothing to set', async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {});

    const res = await patch({ on: [], off: [] });

    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toMatch(/No entitlement switches are registered/);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('says the registration failed in its 409, rather than that there are none', async () => {
    __resetEntitlementRegistryForTests();
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await patch({ on: [], off: [] });

    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toMatch(/failed to register/);
  });

  it('is a 409 when another settings write landed first, writing nothing', async () => {
    const { Prisma } = await import('@prisma/client');
    mockPrisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'x' })
    );

    const res = await patch({ on: ['reports'], off: [] });

    expect(res.status).toBe(409);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('is a 404 for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    expect((await patch({ on: ['reports'], off: [] })).status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("refuses an org's own admin, so it cannot grant itself what it has not bought", async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER));

    const res = await patch({ on: ['reports'], off: [] });

    expect(res.status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/admin/orgs/[id]/entitlements', () => {
  it('puts every registered switch back to its default, keeping what it could not see, and audits it', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: {
        entitlements: { on: ['retired'], off: ['leads', 'reports'] },
        providers: { approved: [] },
      },
    });

    const res = await reset();

    expect(res.status).toBe(200);
    expect(storedSettings()).toEqual({
      providers: { approved: [] },
      entitlements: { on: ['retired'], off: [] },
    });
    expect((await json(res)).data).toMatchObject({ nothingSet: true });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.entitlements.update',
        changes: {
          entitlements: {
            from: { on: ['retired'], off: ['leads', 'reports'] },
            to: { on: ['retired'], off: [] },
          },
        },
      })
    );
  });

  it('removes the slice when nothing is left stored', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { entitlements: { on: [], off: ['leads'] }, providers: { approved: [] } },
    });

    await reset();

    expect(storedSettings()).toEqual({ providers: { approved: [] } });
  });

  it("refuses an org's own admin", async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER));

    expect((await reset()).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });
});

describe('the switches at multi are changed only from the install org, as the caps are', () => {
  it('refuses a platform admin switched into a customer org, before saying which switches exist', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    // From the install org an unregistered key is a 400 naming it. The
    // refusal comes first, so it says nothing about what is registered.
    const res = await patch({ on: ['not_registered'], off: [] });
    const body = await json(res);

    expect(res.status).toBe(403);
    expect(body.error?.code).toBe('FORBIDDEN');
    expect(body.error?.details?.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
    expect(body.error?.message).toMatch(/install organisation/);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'tenancy: refused an org switches write outside the install org',
      expect.objectContaining({ orgId: OTHER, activeOrgId: OTHER })
    );
  });

  it('refuses a customer org before reading the body, so a bad one is not what it is told to fix', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    const res = await patch({ on: ['Bad-Key'] });

    expect(res.status).toBe(403);
    expect((await json(res)).error?.details?.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
  });

  it('refuses clearing them from a customer org too', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    expect((await reset()).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('still lets a platform admin in a customer org read them, saying they cannot be changed from there', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    const res = await get();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual(
      expect.objectContaining({ orgId: OTHER, mayChange: false })
    );
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

    const res = await patch({ on: ['reports'], off: [] });

    expect(res.status).toBe(200);
    expect(storedSettings()).toEqual({
      providers: { approved: ['id-anthropic'] },
      entitlements: { on: ['reports'], off: [] },
    });
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

    expect((await patch({ on: ['reports'], off: [] })).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('lets a platform admin in a customer org set them at single, where there is only one org', async () => {
    mockEnv.TENANCY_MODE = 'single';
    mockGetSession.mockResolvedValue(session('ADMIN', OTHER));

    const res = await patch({ on: ['reports'], off: [] });

    expect(res.status).toBe(200);
    expect(mockPrisma.org.update).toHaveBeenCalledTimes(1);
  });
});
