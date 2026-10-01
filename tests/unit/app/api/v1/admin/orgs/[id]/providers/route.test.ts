/**
 * Unit Tests: GET/PUT /api/v1/admin/orgs/[id]/providers (§120 t-742)
 *
 * Real `withAdminAuth` and the real `writeOrgProviderPolicy`, over a mocked
 * Prisma whose `$transaction` runs the callback against the same mock. Pins:
 * platform-admin only, the replace semantics (other `settings` keys kept), the
 * audit row with its before and after, the install-org refusal, and the
 * unknown-slug refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const mockPrisma = vi.hoisted(() => {
  const db = {
    org: { findUnique: vi.fn(), update: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
    aiProviderConfig: { findMany: vi.fn() },
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

const mockForgetOrgProviderPolicy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/llm/org-provider-policy', () => ({
  forgetOrgProviderPolicy: mockForgetOrgProviderPolicy,
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { GET, PUT } from '@/app/api/v1/admin/orgs/[id]/providers/route';
import { createMockAuthSession } from '@/tests/helpers/auth';

const OTHER = 'cmorg000000000000000other';

/** A session acting in the install org, which the guard verifies at multi. */
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
    new Request(`http://localhost/api/v1/admin/orgs/${id}/providers`) as unknown as NextRequest,
    ctx(id)
  );
const put = (body: unknown, id = OTHER) =>
  PUT(
    new Request(`http://localhost/api/v1/admin/orgs/${id}/providers`, {
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

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma));
  mockPrisma.aiApiKey.findFirst.mockResolvedValue(null);
  mockGetSession.mockResolvedValue(session('ADMIN'));
  mockPrisma.org.findUnique.mockResolvedValue({
    settings: {
      retention: { costLogRetentionDays: 30 },
      providers: { approved: ['id-anthropic'] },
    },
  });
  mockPrisma.orgMembership.findUnique.mockResolvedValue({
    role: 'OWNER',
    org: { status: 'ACTIVE' },
  });
  mockPrisma.org.update.mockResolvedValue({});
  // Provider rows: each slug's id is `id-<slug>`, and `nope` has no row.
  mockPrisma.aiProviderConfig.findMany.mockImplementation(
    async (args: { where: { slug?: { in: string[] }; id?: { in: string[] } } }) => {
      const slugs = args.where.slug
        ? args.where.slug.in
        : (args.where.id?.in ?? []).map((id) => id.replace(/^id-/, ''));
      return slugs.filter((s) => s !== 'nope').map((slug) => ({ id: `id-${slug}`, slug }));
    }
  );
});

describe('GET /api/v1/admin/orgs/[id]/providers', () => {
  it("returns the org's approved set and what it means here", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({
      orgId: OTHER,
      unrestricted: false,
      enforced: true,
      approved: [{ id: 'id-anthropic', slug: 'anthropic' }],
      jurisdictions: null,
    });
  });

  it('reports a grant whose provider row was deleted with no slug', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({
      settings: { providers: { approved: ['id-nope'] } },
    });
    expect((await json(await get())).data).toMatchObject({
      approved: [{ id: 'id-nope', slug: null }],
    });
  });

  it('reports an org never granted anything as approved for nothing', async () => {
    mockPrisma.org.findUnique.mockResolvedValue({ settings: null });
    expect((await json(await get())).data).toMatchObject({ approved: [], jurisdictions: null });
  });

  it('says the install org is unrestricted, and that nothing is enforced at single', async () => {
    mockEnv.TENANCY_MODE = 'single';
    expect((await json(await get(INSTALL_ORG_ID))).data).toMatchObject({
      unrestricted: true,
      enforced: false,
    });
  });

  it('is a 404 for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('ORG_NOT_FOUND');
  });

  it('is platform-admin only', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    expect((await get()).status).toBe(403);
  });
});

describe('PUT /api/v1/admin/orgs/[id]/providers', () => {
  it("stores each slug's row id, keeps the org's other settings, and returns what was stored", async () => {
    const res = await put({ approved: ['openai', 'openai', 'voyage'], jurisdictions: ['eu'] });

    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({
      approved: [
        { id: 'id-openai', slug: 'openai' },
        { id: 'id-voyage', slug: 'voyage' },
      ],
      jurisdictions: ['EU'],
    });
    expect(mockPrisma.org.update).toHaveBeenCalledWith({
      where: { id: OTHER },
      data: {
        settings: {
          retention: { costLogRetentionDays: 30 },
          providers: { approved: ['id-openai', 'id-voyage'], jurisdictions: ['EU'] },
        },
      },
    });
  });

  it('writes an audit row with the policy before and after, and who changed it', async () => {
    await put({ approved: ['openai'], jurisdictions: null });

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: createMockAuthSession().user.id,
        action: 'org.providers.replace',
        entityType: 'org',
        entityId: OTHER,
        changes: {
          providers: { from: { approved: ['id-anthropic'] }, to: { approved: ['id-openai'] } },
        },
        metadata: { approvedSlugs: ['openai'] },
      })
    );
  });

  it("drops this process's cached policy for the org, so a revocation applies at once", async () => {
    await put({ approved: [], jurisdictions: null });
    expect(mockForgetOrgProviderPolicy).toHaveBeenCalledWith(OTHER);
  });

  it('answers a clash with a concurrent settings write with a 409, and audits nothing', async () => {
    const { Prisma } = await import('@prisma/client');
    mockPrisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('could not serialize access', {
        code: 'P2034',
        clientVersion: 'test',
      })
    );

    const res = await put({ approved: ['openai'], jurisdictions: null });

    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe('CONFLICT');
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockForgetOrgProviderPolicy).not.toHaveBeenCalled();
  });

  it('lets any other write failure through as a 500', async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(new Error('connection reset'));
    expect((await put({ approved: ['openai'], jurisdictions: null })).status).toBe(500);
  });

  it('revokes every grant with an empty set', async () => {
    const res = await put({ approved: [], jurisdictions: null });
    expect((await json(res)).data).toMatchObject({ approved: [] });
  });

  it('refuses a slug that names no provider, and writes nothing', async () => {
    const res = await put({ approved: ['openai', 'nope'], jurisdictions: null });

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { unknownProviders: ['nope'] },
    });
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockForgetOrgProviderPolicy).not.toHaveBeenCalled();
  });

  it('refuses the install org, which is unrestricted by rule', async () => {
    const res = await put({ approved: ['openai'], jurisdictions: null }, INSTALL_ORG_ID);
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe('INSTALL_ORG_IMMUTABLE');
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('refuses a body that leaves out jurisdictions — a replace must say whether to lift them', async () => {
    const res = await put({ approved: ['openai'] });
    expect(res.status).toBe(400);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('refuses a body with an unknown key or a malformed jurisdiction', async () => {
    expect((await put({ approved: [], jurisdictions: null, extra: 1 })).status).toBe(400);
    expect((await put({ approved: [], jurisdictions: ['not a code'] })).status).toBe(400);
    expect((await put({ approved: [], jurisdictions: [] })).status).toBe(400);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });

  it('is a 404 for an org that does not exist, whatever the body names, with no audit row', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);
    for (const approved of [['openai'], ['nope'], []]) {
      const res = await put({ approved, jurisdictions: null });
      expect(res.status).toBe(404);
      expect((await json(res)).error?.code).toBe('ORG_NOT_FOUND');
    }
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('is platform-admin only', async () => {
    mockGetSession.mockResolvedValue(session('USER'));
    expect((await put({ approved: ['openai'], jurisdictions: null })).status).toBe(403);
    expect(mockPrisma.org.update).not.toHaveBeenCalled();
  });
});
