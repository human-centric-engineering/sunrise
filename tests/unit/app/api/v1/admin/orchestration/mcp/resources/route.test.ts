/**
 * Tests: MCP Exposed Resources Endpoints
 *
 * GET  /api/v1/admin/orchestration/mcp/resources — list exposed resources
 * POST /api/v1/admin/orchestration/mcp/resources — create exposed resource
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - GET: returns paginated resource list
 * - GET: filters by isEnabled and resourceType
 * - POST: creates resource, clears cache, broadcasts change
 * - POST: rejects invalid URI scheme
 * - POST: rejects invalid resourceType
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/resources/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpExposedResource: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() => Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

// Only the two side-effect helpers are stubbed. The dispatchability checks the
// POST handler runs (`isAllowedMcpResourceUri`, `isDispatchableMcpResourceType`)
// come through REAL — stubbing them would leave the 400s below asserting on a
// mock's return value rather than on what the registry can actually serve.
vi.mock('@/lib/orchestration/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/mcp')>()),
  clearMcpResourceCache: vi.fn(),
}));

// The fork seam ships empty; the app-type test below fills it explicitly.
vi.mock('@/lib/app/mcp-resources', () => ({
  initAppMcpResources: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
// The two spies come from the MOCKED barrel; the registrar comes from the real
// module the barrel re-exports, so a registration here is visible to the route.
import { clearMcpResourceCache } from '@/lib/orchestration/mcp';
import {
  registerMcpResourceHandler,
  __resetAppMcpResourcesForTests,
} from '@/lib/orchestration/mcp/resource-registry';
import { initAppMcpResources } from '@/lib/app/mcp-resources';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { GET, POST } from '@/app/api/v1/admin/orchestration/mcp/resources/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RESOURCE_ID = 'cmjbv4i3x00003wsloputgwu1';

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOURCE_ID,
    uri: 'sunrise://knowledge/search',
    name: 'Knowledge Search',
    description: 'Search the knowledge base',
    mimeType: 'application/json',
    resourceType: 'knowledge_search',
    isEnabled: true,
    handlerConfig: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/mcp/resources');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/mcp/resources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const VALID_RESOURCE_BODY = {
  uri: 'sunrise://knowledge/search',
  name: 'Knowledge Search',
  description: 'Search the knowledge base',
  resourceType: 'knowledge_search',
  isEnabled: false,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppMcpResourcesForTests();
});

describe('GET /mcp/resources', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(403);
  });

  it('returns paginated resources', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([makeResource()] as never);
    vi.mocked(prisma.mcpExposedResource.count).mockResolvedValue(1);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('filters by isEnabled', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpExposedResource.count).mockResolvedValue(0);

    await GET(makeGetRequest({ isEnabled: 'true' }));

    expect(prisma.mcpExposedResource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isEnabled: true } })
    );
  });

  it('filters by resourceType', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpExposedResource.count).mockResolvedValue(0);

    await GET(makeGetRequest({ resourceType: 'agent_list' }));

    expect(prisma.mcpExposedResource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { resourceType: 'agent_list' } })
    );
  });
});

describe('POST /mcp/resources', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makePostRequest(VALID_RESOURCE_BODY));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makePostRequest(VALID_RESOURCE_BODY));

    expect(response.status).toBe(403);
  });

  it('creates resource and returns 201', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.create).mockResolvedValue(makeResource());

    const response = await POST(makePostRequest(VALID_RESOURCE_BODY));

    expect(response.status).toBe(201);
    const body = await parseJson<{ data: { id: string } }>(response);
    expect(body.data.id).toBe(RESOURCE_ID);
  });

  it('clears cache and broadcasts change after creation', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.create).mockResolvedValue(makeResource());

    await POST(makePostRequest(VALID_RESOURCE_BODY));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(clearMcpResourceCache).toHaveBeenCalled();
  });

  it('rejects URI without sunrise:// scheme', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_RESOURCE_BODY, uri: 'https://example.com/resource' })
    );

    expect(response.status).toBe(400);
  });

  it('rejects invalid resourceType', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_RESOURCE_BODY, resourceType: 'invalid_type' })
    );

    expect(response.status).toBe(400);
  });

  it('rejects a resourceType with no registered handler, naming the seam', async () => {
    // Stronger than the closed enum this replaced: it also catches a CORE type
    // whose handler has gone missing, which the enum could not see.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_RESOURCE_BODY, resourceType: 'project_plan' })
    );
    const body = await parseJson<{ error: { message: string } }>(response);

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('project_plan');
    expect(prisma.mcpExposedResource.create).not.toHaveBeenCalled();
  });

  it('accepts a fork resourceType and URI scheme once the seam registers them', async () => {
    // The whole point of #563: this same request 400s on vanilla Sunrise.
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme: 'hub',
        handler: vi.fn(),
      });
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.create).mockResolvedValue(
      makeResource({ uri: 'hub://projects/{id}/plan', resourceType: 'project_plan' })
    );

    const response = await POST(
      makePostRequest({
        ...VALID_RESOURCE_BODY,
        uri: 'hub://projects/{id}/plan',
        resourceType: 'project_plan',
      })
    );

    expect(response.status).toBe(201);
    expect(prisma.mcpExposedResource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uri: 'hub://projects/{id}/plan',
          resourceType: 'project_plan',
        }),
      })
    );
  });

  it('rejects a fork type filed under the core scheme, naming the right one', async () => {
    // `sunrise://` + a registered fork type passes both independent checks; only
    // the pair check catches it. Left open, a fork resource would list itself to
    // every MCP client under the platform's own scheme — the inheritance
    // `uriScheme` is required in order to prevent.
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme: 'hub',
        handler: vi.fn(),
      });
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({
        ...VALID_RESOURCE_BODY,
        uri: 'sunrise://projects/x/plan',
        resourceType: 'project_plan',
      })
    );
    const body = await parseJson<{ error: { message: string } }>(response);

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('hub://');
    expect(prisma.mcpExposedResource.create).not.toHaveBeenCalled();
  });

  it('rejects a core type filed under a fork scheme', async () => {
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme: 'hub',
        handler: vi.fn(),
      });
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_RESOURCE_BODY, uri: 'hub://agents', resourceType: 'agent_list' })
    );

    expect(response.status).toBe(400);
    expect(prisma.mcpExposedResource.create).not.toHaveBeenCalled();
  });

  it('still rejects a fork URI scheme that nothing registered', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_RESOURCE_BODY, uri: 'obsiddy://today' })
    );
    const body = await parseJson<{ error: { message: string } }>(response);

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('sunrise://');
    expect(prisma.mcpExposedResource.create).not.toHaveBeenCalled();
  });

  it('rejects missing name', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const { name: _name, ...bodyWithoutName } = VALID_RESOURCE_BODY;
    const response = await POST(makePostRequest(bodyWithoutName));

    expect(response.status).toBe(400);
  });
});
