/**
 * Integration Test: Admin Orchestration Knowledge Tags (list + create + single CRUD)
 *
 * GET    /api/v1/admin/orchestration/knowledge/tags
 * POST   /api/v1/admin/orchestration/knowledge/tags
 * GET    /api/v1/admin/orchestration/knowledge/tags/:id
 * PATCH  /api/v1/admin/orchestration/knowledge/tags/:id
 * DELETE /api/v1/admin/orchestration/knowledge/tags/:id?force=true
 *
 * @see app/api/v1/admin/orchestration/knowledge/tags/route.ts
 * @see app/api/v1/admin/orchestration/knowledge/tags/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as listGet, POST } from '@/app/api/v1/admin/orchestration/knowledge/tags/route';
import {
  GET as getById,
  PATCH,
  DELETE,
} from '@/app/api/v1/admin/orchestration/knowledge/tags/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { Prisma } from '@prisma/client';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    knowledgeTag: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  invalidateAllAgentAccess: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TAG_ID = 'cmjbv4i3x00003wsloputgwul';

function makeTag(
  overrides: Record<string, unknown> = {},
  count: { documents: number; agents: number } = { documents: 0, agents: 0 }
) {
  return {
    id: TAG_ID,
    slug: 'support',
    name: 'Support',
    description: 'Customer support docs',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    _count: count,
    // GET now returns the linked docs/agents as join-shaped relations so the
    // drill-down on the Tags admin can show what each tag actually covers.
    // Tests pass through arrays via overrides when they want to assert on
    // these — otherwise the route flattens them into empty arrays.
    documents: [] as Array<{ document: unknown }>,
    agents: [] as Array<{ agent: unknown }>,
    ...overrides,
  };
}

function makeListRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/knowledge/tags');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeBodyRequest(method: string, body: Record<string, unknown>): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/tags',
  } as unknown as NextRequest;
}

function makeByIdRequest(
  method = 'GET',
  body?: Record<string, unknown>,
  query?: string
): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/tags/${TAG_ID}${query ?? ''}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/knowledge/tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await listGet(makeListRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await listGet(makeListRequest());

    expect(response.status).toBe(403);
  });

  it('returns paginated tags with document/agent counts', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findMany).mockResolvedValue([
      makeTag({}, { documents: 3, agents: 2 }),
    ] as never);
    vi.mocked(prisma.knowledgeTag.count).mockResolvedValue(1);

    const response = await listGet(makeListRequest());

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: Array<{ id: string; slug: string; documentCount: number; agentCount: number }>;
      meta: unknown;
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].documentCount).toBe(3);
    expect(data.data[0].agentCount).toBe(2);
    expect(data.meta).toBeDefined();
  });

  it('passes search query to prisma when q is set', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledgeTag.count).mockResolvedValue(0);

    await listGet(makeListRequest({ q: 'billing' }));

    expect(vi.mocked(prisma.knowledgeTag.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ slug: { contains: 'billing', mode: 'insensitive' } }),
          ]),
        }),
      })
    );
  });
});

describe('POST /api/v1/admin/orchestration/knowledge/tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a tag and returns 201 with the new row', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.create).mockResolvedValue(makeTag() as never);

    const response = await POST(makeBodyRequest('POST', { slug: 'support', name: 'Support' }));

    expect(response.status).toBe(201);
    const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe(TAG_ID);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge_tag.create' })
    );
  });

  it('returns 409 when slug already exists', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      })
    );

    const response = await POST(makeBodyRequest('POST', { slug: 'support', name: 'Support' }));

    expect(response.status).toBe(409);
  });

  it('returns 400 when slug is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeBodyRequest('POST', { name: 'No Slug' }));

    expect(response.status).toBe(400);
  });

  it('rejects slugs with invalid characters', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeBodyRequest('POST', { slug: 'Has Spaces!', name: 'Bad' }));

    expect(response.status).toBe(400);
  });
});

describe('GET /api/v1/admin/orchestration/knowledge/tags/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the tag with link counts', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
      makeTag({}, { documents: 5, agents: 1 }) as never
    );

    const response = await getById(makeByIdRequest('GET'), makeParams(TAG_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: { documentCount: number; agentCount: number };
    }>(response);
    expect(data.data.documentCount).toBe(5);
    expect(data.data.agentCount).toBe(1);
  });

  it('returns 404 when the tag does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(null);

    const response = await getById(makeByIdRequest('GET'), makeParams(TAG_ID));

    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/v1/admin/orchestration/knowledge/tags/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates name and invalidates the resolver cache', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);
    vi.mocked(prisma.knowledgeTag.update).mockResolvedValue(makeTag({ name: 'Renamed' }) as never);

    const response = await PATCH(makeByIdRequest('PATCH', { name: 'Renamed' }), makeParams(TAG_ID));

    expect(response.status).toBe(200);
    expect(invalidateAllAgentAccess).toHaveBeenCalled();
  });

  it('returns 400 when the body is empty', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);

    const response = await PATCH(makeByIdRequest('PATCH', {}), makeParams(TAG_ID));

    expect(response.status).toBe(400);
  });

  it('returns 409 when slug collides with an existing tag', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(makeTag() as never);
    vi.mocked(prisma.knowledgeTag.update).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      })
    );

    const response = await PATCH(
      makeByIdRequest('PATCH', { slug: 'already-taken' }),
      makeParams(TAG_ID)
    );

    expect(response.status).toBe(409);
  });
});

describe('DELETE /api/v1/admin/orchestration/knowledge/tags/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes a tag with no links and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
      makeTag({}, { documents: 0, agents: 0 }) as never
    );
    vi.mocked(prisma.knowledgeTag.delete).mockResolvedValue(makeTag() as never);

    const response = await DELETE(makeByIdRequest('DELETE'), makeParams(TAG_ID));

    expect(response.status).toBe(200);
    expect(invalidateAllAgentAccess).toHaveBeenCalled();
  });

  it('returns 409 with agent details when the tag is granted to one or more agents', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
      makeTag(
        {
          agents: [
            { agent: { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' } },
            { agent: { id: 'agent-2', name: 'Sales Bot', slug: 'sales-bot' } },
          ],
        },
        { documents: 0, agents: 2 }
      ) as never
    );

    const response = await DELETE(makeByIdRequest('DELETE'), makeParams(TAG_ID));

    expect(response.status).toBe(409);
    expect(vi.mocked(prisma.knowledgeTag.delete)).not.toHaveBeenCalled();
    const data = (await response.json()) as {
      error: { details: { agentCount: number; agents: Array<{ id: string; name: string }> } };
    };
    expect(data.error.details.agentCount).toBe(2);
    expect(data.error.details.agents).toEqual([
      { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' },
      { id: 'agent-2', name: 'Sales Bot', slug: 'sales-bot' },
    ]);
  });

  it('does NOT allow ?force=true to bypass an agent-bound tag delete', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
      makeTag(
        { agents: [{ agent: { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' } }] },
        { documents: 0, agents: 1 }
      ) as never
    );

    const response = await DELETE(
      makeByIdRequest('DELETE', undefined, '?force=true'),
      makeParams(TAG_ID)
    );

    expect(response.status).toBe(409);
    expect(vi.mocked(prisma.knowledgeTag.delete)).not.toHaveBeenCalled();
  });

  it('returns 409 when only documents are linked and force is not set', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
      makeTag({}, { documents: 4, agents: 0 }) as never
    );

    const response = await DELETE(makeByIdRequest('DELETE'), makeParams(TAG_ID));

    expect(response.status).toBe(409);
    expect(vi.mocked(prisma.knowledgeTag.delete)).not.toHaveBeenCalled();
  });

  it('deletes when only documents are linked and ?force=true is set', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(
      makeTag({}, { documents: 4, agents: 0 }) as never
    );
    vi.mocked(prisma.knowledgeTag.delete).mockResolvedValue(makeTag() as never);

    const response = await DELETE(
      makeByIdRequest('DELETE', undefined, '?force=true'),
      makeParams(TAG_ID)
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(prisma.knowledgeTag.delete)).toHaveBeenCalledWith({ where: { id: TAG_ID } });
  });
});
