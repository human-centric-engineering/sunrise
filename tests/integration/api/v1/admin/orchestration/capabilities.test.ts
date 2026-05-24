/**
 * Integration Test: Admin Orchestration Capabilities (list + create + single CRUD)
 *
 * GET    /api/v1/admin/orchestration/capabilities
 * POST   /api/v1/admin/orchestration/capabilities
 * GET    /api/v1/admin/orchestration/capabilities/:id
 * PATCH  /api/v1/admin/orchestration/capabilities/:id
 * DELETE /api/v1/admin/orchestration/capabilities/:id
 *
 * capabilityDispatcher.clearCache() is called on POST, PATCH, and DELETE.
 *
 * @see app/api/v1/admin/orchestration/capabilities/route.ts
 * @see app/api/v1/admin/orchestration/capabilities/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as listGet, POST } from '@/app/api/v1/admin/orchestration/capabilities/route';
import {
  GET as getById,
  PATCH,
  DELETE,
} from '@/app/api/v1/admin/orchestration/capabilities/[id]/route';
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
    aiCapability: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  capabilityDispatcher: { clearCache: vi.fn() },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CAPABILITY_ID = 'cmjbv4i3x00003wsloputgwul';

const VALID_CAPABILITY = {
  name: 'Search Web',
  slug: 'search-web',
  description: 'Searches the web for information',
  category: 'search',
  functionDefinition: { name: 'search_web', description: 'Search the web', parameters: {} },
  executionType: 'internal' as const,
  executionHandler: 'lib/capabilities/search-web.ts',
  requiresApproval: false,
  isActive: true,
};

function makeCapability(overrides: Record<string, unknown> = {}) {
  return {
    id: CAPABILITY_ID,
    name: 'Search Web',
    slug: 'search-web',
    description: 'Searches the web for information',
    category: 'search',
    functionDefinition: { name: 'search_web', description: 'Search the web', parameters: {} },
    executionType: 'internal',
    executionHandler: 'lib/capabilities/search-web.ts',
    executionConfig: null,
    requiresApproval: false,
    rateLimit: null,
    isActive: true,
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    // Raw pivot relation returned by findMany with include: { agents: { include: { agent: ... } } }
    agents: [],
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeListRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/capabilities');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeBodyRequest(method: string, body: Record<string, unknown>): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/capabilities',
  } as unknown as NextRequest;
}

function makeByIdRequest(method = 'GET', body?: Record<string, unknown>): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost:3000/api/v1/admin/orchestration/capabilities/${CAPABILITY_ID}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests: GET /capabilities ────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
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
  });

  describe('Successful retrieval', () => {
    it('returns paginated capabilities list', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([makeCapability()] as never);
      vi.mocked(prisma.aiCapability.count).mockResolvedValue(1);

      const response = await listGet(makeListRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ _agents: unknown[] }>;
        meta: unknown;
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.meta).toBeDefined();
      // Route handler flattens pivot relation into _agents array
      expect(data.data[0]._agents).toEqual([]);
    });

    it('passes isActive filter to Prisma when set to true', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiCapability.count).mockResolvedValue(0);

      await listGet(makeListRequest({ isActive: 'true' }));

      expect(vi.mocked(prisma.aiCapability.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
          include: expect.objectContaining({ agents: expect.anything() }),
        })
      );
    });

    it('passes category filter to Prisma', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiCapability.count).mockResolvedValue(0);

      await listGet(makeListRequest({ category: 'search' }));

      expect(vi.mocked(prisma.aiCapability.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: 'search' }),
          include: expect.objectContaining({ agents: expect.anything() }),
        })
      );
    });

    it('passes a 3-field OR clause to Prisma when q is provided (line 43)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiCapability.count).mockResolvedValue(0);

      await listGet(makeListRequest({ q: 'search-term' }));

      // The route builds an OR clause with case-insensitive contains over three fields.
      // Asserting the exact shape of each entry catches regressions that: drop a field
      // from the OR, swap 'contains' for 'equals', or remove the 'insensitive' mode.
      expect(vi.mocked(prisma.aiCapability.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { name: { contains: 'search-term', mode: 'insensitive' } },
              { slug: { contains: 'search-term', mode: 'insensitive' } },
              { description: { contains: 'search-term', mode: 'insensitive' } },
            ],
          }),
        })
      );
      // Also assert length to catch regressions that add or drop OR branches.
      const passedWhere = vi.mocked(prisma.aiCapability.findMany).mock.calls[0]?.[0]?.where as {
        OR?: unknown[];
      };
      expect(passedWhere?.OR).toHaveLength(3);
    });

    it('flattens pivot rows into _agents and strips pivot metadata (line 69)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([
        makeCapability({
          agents: [
            {
              id: 'pivot-1',
              customConfig: { secret: 'leak' },
              agent: { id: 'agent-1', name: 'My Agent', slug: 'my-agent', isActive: true },
            },
          ],
        }),
      ] as never);
      vi.mocked(prisma.aiCapability.count).mockResolvedValue(1);

      const response = await listGet(makeListRequest());
      expect(response.status).toBe(200);

      const body = await parseJson<{
        success: boolean;
        data: Array<{
          _agents: Array<{ id: string; name: string; slug: string; isActive: boolean }>;
          agents?: unknown;
        }>;
      }>(response);

      // Load-bearing assertion: _agents must contain only the agent sub-object,
      // not the raw pivot row. If line 69's `.map((l) => l.agent)` were replaced
      // with just `links`, this assertion would fail because the object would also
      // have `id: 'pivot-1'` and `customConfig: { secret: 'leak' }`.
      expect(body.data[0]._agents).toEqual([
        { id: 'agent-1', name: 'My Agent', slug: 'my-agent', isActive: true },
      ]);
      // Pivot-row metadata must NOT be present on the extracted agent object.
      expect(body.data[0]._agents[0]).not.toHaveProperty('customConfig');
      // The raw `agents` pivot relation must be destructured away — not exposed on the item.
      expect(body.data[0]).not.toHaveProperty('agents');
    });
  });
});

// ─── Tests: POST /capabilities ───────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeBodyRequest('POST', VALID_CAPABILITY));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeBodyRequest('POST', VALID_CAPABILITY));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful creation', () => {
    it('creates capability and returns 201', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.create).mockResolvedValue(makeCapability() as never);

      const response = await POST(makeBodyRequest('POST', VALID_CAPABILITY));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { slug: string } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.slug).toBe('search-web');
    });

    it('calls capabilityDispatcher.clearCache after creation', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.create).mockResolvedValue(makeCapability() as never);

      await POST(makeBodyRequest('POST', VALID_CAPABILITY));

      expect(vi.mocked(capabilityDispatcher.clearCache)).toHaveBeenCalledOnce();
    });
  });

  describe('Error cases', () => {
    it('returns 400 for missing required fields', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeBodyRequest('POST', {}));

      expect(response.status).toBe(400);
    });

    it('returns 409 when slug already exists (P2002)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiCapability.create).mockRejectedValue(p2002);

      const response = await POST(makeBodyRequest('POST', VALID_CAPABILITY));

      expect(response.status).toBe(409);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    });

    it('returns 400 when executionType is api but executionHandler is not a URL', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makeBodyRequest('POST', {
          ...VALID_CAPABILITY,
          executionType: 'api',
          executionHandler: 'not-a-url',
        })
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when executionType is webhook but executionHandler is not a URL', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(
        makeBodyRequest('POST', {
          ...VALID_CAPABILITY,
          executionType: 'webhook',
          executionHandler: 'not-a-url',
        })
      );

      expect(response.status).toBe(400);
    });

    it('accepts valid URL for api executionType', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.create).mockResolvedValue(makeCapability() as never);

      const response = await POST(
        makeBodyRequest('POST', {
          ...VALID_CAPABILITY,
          executionType: 'api',
          executionHandler: 'https://api.example.com/lookup',
        })
      );

      expect(response.status).toBe(201);
    });

    it('rethrows non-P2002 errors — guard returns 500, not 409 (line 124)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.create).mockRejectedValue(new Error('connection lost'));

      // The route's catch block only intercepts P2002 (slug conflict); all other
      // errors are re-thrown via `throw err`. The withAdminAuth guard then converts
      // the rethrown error to a 500 INTERNAL_ERROR response. A regression that
      // accidentally caught this error and returned 409 instead of rethrowing would
      // fail this assertion — the status would be 409, not 500.
      const response = await POST(makeBodyRequest('POST', VALID_CAPABILITY));
      expect(response.status).toBe(500);
      const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).not.toBe('CONFLICT');
    });
  });
});

// ─── Tests: GET /capabilities/:id ────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/capabilities/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await getById(makeByIdRequest(), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await getById(makeByIdRequest(), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns capability by id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);

      const response = await getById(makeByIdRequest(), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(CAPABILITY_ID);
    });
  });

  describe('Error cases', () => {
    it('returns 400 for invalid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await getById(makeByIdRequest(), makeParams('bad-id'));

      expect(response.status).toBe(400);
    });

    it('returns 404 when capability not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(null);

      const response = await getById(makeByIdRequest(), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(404);
    });
  });
});

// ─── Tests: PATCH /capabilities/:id ─────────────────────────────────────────

describe('PATCH /api/v1/admin/orchestration/capabilities/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await PATCH(
        makeByIdRequest('PATCH', { name: 'Updated Name' }),
        makeParams(CAPABILITY_ID)
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await PATCH(
        makeByIdRequest('PATCH', { name: 'Updated Name' }),
        makeParams(CAPABILITY_ID)
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Successful update', () => {
    it('updates capability and clears cache', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiCapability.update).mockResolvedValue(
        makeCapability({ name: 'Updated Name' }) as never
      );

      const response = await PATCH(
        makeByIdRequest('PATCH', { name: 'Updated Name' }),
        makeParams(CAPABILITY_ID)
      );

      expect(response.status).toBe(200);
      expect(vi.mocked(capabilityDispatcher.clearCache)).toHaveBeenCalledOnce();
    });

    it('updates all optional fields in a single payload', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiCapability.update).mockResolvedValue(makeCapability() as never);

      const fullPayload = {
        name: 'New Name',
        slug: 'new-slug',
        description: 'New description',
        category: 'new-category',
        functionDefinition: { name: 'fn', description: 'd', parameters: {} },
        executionType: 'api' as const,
        executionHandler: 'https://example.com/handler',
        executionConfig: { timeout: 5000 },
        requiresApproval: true,
        rateLimit: 60,
        isActive: false,
        metadata: { owner: 'platform' },
      };

      await PATCH(makeByIdRequest('PATCH', fullPayload), makeParams(CAPABILITY_ID));

      const updateCall = vi.mocked(prisma.aiCapability.update).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        name: 'New Name',
        slug: 'new-slug',
        description: 'New description',
        category: 'new-category',
        executionType: 'api',
        executionHandler: 'https://example.com/handler',
        executionConfig: { timeout: 5000 },
        requiresApproval: true,
        rateLimit: 60,
        isActive: false,
        metadata: { owner: 'platform' },
      });
    });
  });

  describe('Error cases', () => {
    it('returns 404 when capability not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(null);

      const response = await PATCH(
        makeByIdRequest('PATCH', { name: 'x' }),
        makeParams(CAPABILITY_ID)
      );

      expect(response.status).toBe(404);
    });

    it('returns 400 when PATCH changes executionHandler to non-URL for existing api capability', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(
        makeCapability({
          executionType: 'api',
          executionHandler: 'https://api.example.com',
        }) as never
      );

      const response = await PATCH(
        makeByIdRequest('PATCH', { executionHandler: 'not-a-url' }),
        makeParams(CAPABILITY_ID)
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when PATCH changes executionHandler to non-URL for existing webhook capability', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(
        makeCapability({
          executionType: 'webhook',
          executionHandler: 'https://hooks.example.com',
        }) as never
      );

      const response = await PATCH(
        makeByIdRequest('PATCH', { executionHandler: 'not-a-url' }),
        makeParams(CAPABILITY_ID)
      );

      expect(response.status).toBe(400);
    });

    it('allows non-URL executionHandler for internal capability', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(
        makeCapability({ executionType: 'internal' }) as never
      );
      vi.mocked(prisma.aiCapability.update).mockResolvedValue(
        makeCapability({ executionHandler: 'MyNewCapability' }) as never
      );

      const response = await PATCH(
        makeByIdRequest('PATCH', { executionHandler: 'MyNewCapability' }),
        makeParams(CAPABILITY_ID)
      );

      expect(response.status).toBe(200);
    });

    it('returns 400 for P2002 slug conflict on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiCapability.update).mockRejectedValue(p2002);

      const response = await PATCH(
        makeByIdRequest('PATCH', { slug: 'taken-slug' }),
        makeParams(CAPABILITY_ID)
      );

      expect(response.status).toBe(400);
    });
  });
});

// ─── Tests: DELETE /capabilities/:id ─────────────────────────────────────────

describe('DELETE /api/v1/admin/orchestration/capabilities/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeByIdRequest('DELETE'), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeByIdRequest('DELETE'), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful soft delete', () => {
    it('sets isActive to false, calls clearCache, and returns success', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(makeCapability() as never);
      vi.mocked(prisma.aiCapability.update).mockResolvedValue(
        makeCapability({ isActive: false }) as never
      );

      const response = await DELETE(makeByIdRequest('DELETE'), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { isActive: boolean } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.isActive).toBe(false);

      expect(vi.mocked(prisma.aiCapability.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } })
      );
      expect(vi.mocked(capabilityDispatcher.clearCache)).toHaveBeenCalledOnce();
    });
  });

  describe('Error cases', () => {
    it('returns 404 when capability not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(null);

      const response = await DELETE(makeByIdRequest('DELETE'), makeParams(CAPABILITY_ID));

      expect(response.status).toBe(404);
    });
  });
});
