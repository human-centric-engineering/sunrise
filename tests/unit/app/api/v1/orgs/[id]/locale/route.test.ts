/**
 * Unit Tests: PUT /api/v1/orgs/[id]/locale (§138 t-1071)
 *
 * Real `withAuth`, the real default policy and the real `writeOrgLocale`,
 * over a mocked Prisma. Pins: an org's own admin, acting in it, sets or
 * clears the org's default language, audited, and every other settings key
 * survives; a locale with no catalogue is a 400 and writes nothing; a member,
 * another org, an API key and a support session are refused.
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

import { PUT } from '@/app/api/v1/orgs/[id]/locale/route';
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

const put = (body: unknown, id = ORG) =>
  PUT(
    new Request(`http://localhost/api/v1/orgs/${id}/locale`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) }
  );

async function json(res: Response) {
  return JSON.parse(await res.text()) as {
    success: boolean;
    data?: { orgId: string; locale: string | null };
    error?: { code: string; message?: string };
  };
}

function orgStores(settings: unknown, id = ORG) {
  mockPrisma.org.findUnique.mockResolvedValue({ id, settings });
}

function orgRole(role: 'OWNER' | 'ADMIN' | 'MEMBER') {
  mockPrisma.orgMembership.findUnique.mockResolvedValue({ role, org: { status: 'ACTIVE' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  support.on = false;
  mockEnv.TENANCY_MODE = 'multi';
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
  mockResolveApiKey.mockResolvedValue(null);
  mockGetSession.mockResolvedValue(session());
  orgRole('ADMIN');
  orgStores({ retention: { conversationsDays: 30 } });
  mockPrisma.org.update.mockResolvedValue({});
});

describe('PUT /api/v1/orgs/[id]/locale', () => {
  it("sets the org's default language, keeping every other key, and audits it", async () => {
    const res = await put({ locale: 'en-xa' });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ orgId: ORG, locale: 'en-XA' });
    expect(mockPrisma.org.update).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { settings: { retention: { conversationsDays: 30 }, locale: 'en-XA' } },
    });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.locale.update',
        entityId: ORG,
        actingOrgId: ORG,
        changes: { locale: { from: null, to: 'en-XA' } },
      })
    );
  });

  it('clears the default with null', async () => {
    orgStores({ retention: { conversationsDays: 30 }, locale: 'en-XA' });
    const res = await put({ locale: null });
    expect(res.status).toBe(200);
    expect(mockPrisma.org.update).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { settings: { retention: { conversationsDays: 30 } } },
    });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { locale: { from: 'en-XA', to: null } } })
    );
  });

  it('writes and audits nothing when the value is unchanged', async () => {
    orgStores({ locale: 'en' });
    expect((await put({ locale: 'en' })).status).toBe(200);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — same value;
    expect(mockLogAdminAction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing changed;
  });

  it('refuses a locale with no catalogue, writing nothing', async () => {
    const res = await put({ locale: 'fr' });
    expect(res.status).toBe(400);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused by validation;
  });

  it('refuses a member who is not an admin, by the policy', async () => {
    orgRole('MEMBER');
    expect((await put({ locale: 'en' })).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused;
  });

  it('refuses another org, even to an admin of their own', async () => {
    orgStores({}, OTHER);
    const res = await put({ locale: 'en' }, OTHER);
    expect(res.status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused;
  });

  it('refuses a support session', async () => {
    support.on = true;
    const res = await put({ locale: 'en' });
    expect(res.status).toBe(403);
    expect((await json(res)).error?.message).toContain('Support staff');
  });

  it('refuses an API key', async () => {
    const admin = session(ORG);
    mockResolveApiKey.mockResolvedValue({
      session: {
        ...admin,
        session: { ...admin.session, id: `${API_KEY_SESSION_ID_PREFIX}key_1` },
        user: { ...admin.user, role: 'ADMIN' },
      },
      scopes: ['admin'],
      rateLimitRpm: null,
      orgId: null,
      ownerAccountType: 'HUMAN',
    });
    const res = await put({ locale: 'en' });
    expect(res.status).toBe(403);
    expect((await json(res)).error?.message).toContain('browser session');
  });

  it('answers 409 on a clash with another settings write, auditing nothing', async () => {
    const { Prisma } = await import('@prisma/client');
    mockPrisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'x' })
    );
    expect((await put({ locale: 'en' })).status).toBe(409);
    expect(mockLogAdminAction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing landed;
  });

  it('answers 404 when the org is gone by the time it is written', async () => {
    // The resolver found it; the write's own read did not.
    mockPrisma.org.findUnique
      .mockResolvedValueOnce({ id: ORG, settings: {} })
      .mockResolvedValue(null);
    expect((await put({ locale: 'en' })).status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing written;
  });

  it('lets an error that is not a settings clash through as a 500', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('connection reset'));
    expect((await put({ locale: 'en' })).status).toBe(500);
  });
});
