/**
 * Unit Tests: GET/PUT /api/v1/admin/orgs/[id]/privacy (§127 t-1010)
 *
 * Real `withAdminAuth` and the real `writeOrgPrivacy`, over a mocked Prisma
 * whose `$transaction` runs the callback against the same mock. Pins:
 * platform-admin only, both keys required, the replace keeping every other
 * `settings` key, an unreadable slice reported as such, the 409 on a clash,
 * and an audit row that carries the mode and a count, never a name.
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

import { GET, PUT } from '@/app/api/v1/admin/orgs/[id]/privacy/route';
import { createMockAuthSession } from '@/tests/helpers/auth';

const OTHER = 'cmorg000000000000000other';
const CLIENT = 'Jane Hart';

function session(role: 'USER' | 'ADMIN') {
  const base = createMockAuthSession();
  return {
    ...base,
    session: { ...base.session, activeOrgId: INSTALL_ORG_ID },
    user: { ...base.user, role },
  };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = OTHER) =>
  GET(
    new Request(`http://localhost/api/v1/admin/orgs/${id}/privacy`) as unknown as NextRequest,
    ctx(id)
  );
const put = (body: unknown, id = OTHER) =>
  PUT(
    new Request(`http://localhost/api/v1/admin/orgs/${id}/privacy`, {
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
    error?: { code: string; details?: Record<string, unknown> };
  };
}

const VALID = {
  minimumMode: 'pseudonymise',
  protectedTerms: [
    { value: CLIENT, type: 'PERSON' },
    { value: 'Acme', type: 'ORG' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
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

describe('GET /api/v1/admin/orgs/[id]/privacy', () => {
  it('reports an org that never saved its settings as not saved, with nothing set', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({
      orgId: OTHER,
      saved: false,
      unreadable: false,
      minimumMode: null,
      protectedTerms: [],
    });
  });

  it('returns the stored settings', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ settings: { privacy: VALID } });

    expect((await json(await get())).data).toEqual({
      orgId: OTHER,
      saved: true,
      unreadable: false,
      ...VALID,
    });
  });

  it('reports an unreadable slice with what still parses of it, so a save keeps that', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: {
        privacy: {
          minimumMode: 'block',
          protectedTerms: [
            { value: CLIENT, type: 'PERSON' },
            { value: 'x', type: 'PERSON' },
          ],
        },
      },
    });

    expect((await json(await get())).data).toEqual({
      orgId: OTHER,
      saved: true,
      unreadable: true,
      minimumMode: 'block',
      protectedTerms: [{ value: CLIENT, type: 'PERSON' }],
    });
  });

  it('says a stored slice is unreadable rather than report it as empty', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { privacy: { minimumMode: 'off', protectedTerms: [] } },
    });

    expect((await json(await get())).data).toMatchObject({ saved: true, unreadable: true });
  });

  it('answers 404 for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it('refuses a caller who is not a platform admin', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    expect((await get()).status).toBe(403);
  });
});

describe('PUT /api/v1/admin/orgs/[id]/privacy', () => {
  it("stores the settings, keeping every other key in the org's settings", async () => {
    const res = await put(VALID);

    expect(res.status).toBe(200);
    expect(mockPrisma.org.update).toHaveBeenCalledWith({
      where: { id: OTHER },
      data: {
        settings: { providers: { approved: ['id-anthropic'] }, privacy: VALID },
      },
    });
    expect((await json(res)).data).toEqual({
      orgId: OTHER,
      saved: true,
      unreadable: false,
      ...VALID,
    });
  });

  it('stores an empty set too, so the org is not offered its own name again', async () => {
    await put({ minimumMode: null, protectedTerms: [] });

    expect(mockPrisma.org.update).toHaveBeenCalledWith({
      where: { id: OTHER },
      data: {
        settings: {
          providers: { approved: ['id-anthropic'] },
          privacy: { minimumMode: null, protectedTerms: [] },
        },
      },
    });
  });

  it('keeps one of a name given twice, ignoring case', async () => {
    const res = await put({
      minimumMode: null,
      protectedTerms: [
        { value: CLIENT, type: 'PERSON' },
        { value: 'jane hart', type: 'PERSON' },
      ],
    });

    expect((await json(res)).data?.protectedTerms).toEqual([{ value: CLIENT, type: 'PERSON' }]);
  });

  it.each([
    ['a body without the minimum', { protectedTerms: [] }],
    ['a body without the terms', { minimumMode: null }],
    ['the mode off, which a minimum cannot be', { minimumMode: 'off', protectedTerms: [] }],
    [
      'a term under three characters',
      { minimumMode: null, protectedTerms: [{ value: 'Al', type: 'PERSON' }] },
    ],
    [
      'a term of a kind it does not protect',
      { minimumMode: null, protectedTerms: [{ value: 'a@b.com', type: 'EMAIL' }] },
    ],
    ['an unknown key', { ...VALID, extra: true }],
  ])('refuses %s with a 400, writing nothing', async (_label, body) => {
    const res = await put(body);

    expect(res.status).toBe(400);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('audits the mode and how many terms, never the names', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: {
        privacy: {
          minimumMode: 'detect',
          protectedTerms: [{ value: 'Old Client', type: 'PERSON' }],
        },
      },
    });

    await put(VALID);

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.privacy.replace',
        entityType: 'org',
        entityId: OTHER,
        actingOrgId: OTHER,
        changes: {
          privacy: {
            from: { minimumMode: 'detect', protectedTermCount: 1 },
            to: { minimumMode: 'pseudonymise', protectedTermCount: 2 },
          },
        },
      })
    );
    const logged = JSON.stringify([mockLogAdminAction.mock.calls, mockLog.info.mock.calls]);
    expect(logged).not.toContain(CLIENT);
    expect(logged).not.toContain('Old Client');
  });

  it('audits an unreadable slice it replaced as unreadable', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ settings: { privacy: 'garbled' } });

    await put(VALID);

    expect(mockLogAdminAction.mock.calls[0][0].changes.privacy.from).toEqual({ unreadable: true });
  });

  it('answers a clash with a concurrent settings write with a 409, and audits nothing', async () => {
    const { Prisma } = await import('@prisma/client');
    mockPrisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('could not serialize access', {
        code: 'P2034',
        clientVersion: 'test',
      })
    );

    const res = await put(VALID);

    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe('CONFLICT');
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('lets any other write failure through as a 500', async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(new Error('connection reset'));
    expect((await put(VALID)).status).toBe(500);
  });

  it('answers 404 for an org that does not exist, writing nothing', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    expect((await put(VALID)).status).toBe(404);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not a platform admin', async () => {
    mockGetSession.mockResolvedValue(session('USER'));

    expect((await put(VALID)).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });
});
