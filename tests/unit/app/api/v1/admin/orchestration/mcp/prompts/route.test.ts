/**
 * Tests: MCP Exposed Prompts Endpoints
 *
 * GET  /api/v1/admin/orchestration/mcp/prompts — list
 * POST /api/v1/admin/orchestration/mcp/prompts — create
 *
 * Coverage focus:
 *  - Auth guards (401 / 403)
 *  - Pagination + isEnabled filter
 *  - Create happy-path: row written, cache cleared, list_changed broadcast
 *  - 200-prompt cap enforcement when isEnabled=true
 *  - Validation rejections (bad name regex, oversize template)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpExposedPrompt: {
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

vi.mock('@/lib/orchestration/mcp', () => ({
  clearMcpPromptCache: vi.fn(),
  MAX_ENABLED_PROMPTS: 200,
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { clearMcpPromptCache } from '@/lib/orchestration/mcp';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { GET, POST } from '@/app/api/v1/admin/orchestration/mcp/prompts/route';

const PROMPT_ID = 'cmjbv4i3x00003wsloputgwu1';

function makePrompt(overrides: Record<string, unknown> = {}) {
  return {
    id: PROMPT_ID,
    name: 'analyze-pattern',
    description: 'Analyze a pattern',
    template: 'analyze {{pattern_number}}',
    argumentsSpec: [{ name: 'pattern_number', description: 'number', required: true }],
    isEnabled: true,
    createdBy: 'admin-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/mcp/prompts');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/mcp/prompts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const VALID_BODY = {
  name: 'analyze-pattern',
  description: 'Analyze a pattern',
  template: 'analyze {{pattern_number}}',
  argumentsSpec: [{ name: 'pattern_number', description: 'number', required: true }],
  isEnabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /mcp/prompts', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeGetRequest());
    expect(response.status).toBe(401);
  });

  it('returns 403 when non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeGetRequest());
    expect(response.status).toBe(403);
  });

  it('returns paginated prompts', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findMany).mockResolvedValue([makePrompt()] as never);
    vi.mocked(prisma.mcpExposedPrompt.count).mockResolvedValue(1);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('filters by isEnabled', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpExposedPrompt.count).mockResolvedValue(0);

    await GET(makeGetRequest({ isEnabled: 'false' }));

    expect(prisma.mcpExposedPrompt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isEnabled: false } })
    );
  });
});

describe('POST /mcp/prompts', () => {
  it('returns 403 when non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await POST(makePostRequest(VALID_BODY));
    expect(response.status).toBe(403);
  });

  it('creates a prompt and broadcasts list_changed', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.count).mockResolvedValue(0);
    vi.mocked(prisma.mcpExposedPrompt.create).mockResolvedValue(makePrompt() as never);

    const response = await POST(makePostRequest(VALID_BODY));

    expect(response.status).toBe(201);
    expect(prisma.mcpExposedPrompt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'analyze-pattern', isEnabled: true }),
      })
    );
    expect(clearMcpPromptCache).toHaveBeenCalled();
  });

  it('rejects names that do not match the regex', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await POST(makePostRequest({ ...VALID_BODY, name: 'BadName' }));
    expect(response.status).toBe(400);
  });

  it('rejects oversized templates', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await POST(makePostRequest({ ...VALID_BODY, template: 'x'.repeat(10_001) }));
    expect(response.status).toBe(400);
  });

  it('rejects more than 20 arguments', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const tooManyArgs = Array.from({ length: 21 }, (_, i) => ({
      name: `a${String(i)}`,
      description: 'd',
      required: false,
    }));
    const response = await POST(makePostRequest({ ...VALID_BODY, argumentsSpec: tooManyArgs }));
    expect(response.status).toBe(400);
  });

  it('returns 409 PROMPT_CAP_EXCEEDED when enabled count is at the cap', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.count).mockResolvedValue(200);

    const response = await POST(makePostRequest(VALID_BODY));

    expect(response.status).toBe(409);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('PROMPT_CAP_EXCEEDED');
    expect(prisma.mcpExposedPrompt.create).not.toHaveBeenCalled();
  });

  it('allows creation when isEnabled=false even if cap is reached', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.count).mockResolvedValue(200);
    vi.mocked(prisma.mcpExposedPrompt.create).mockResolvedValue(
      makePrompt({ isEnabled: false }) as never
    );

    const response = await POST(makePostRequest({ ...VALID_BODY, isEnabled: false }));

    expect(response.status).toBe(201);
    expect(prisma.mcpExposedPrompt.count).not.toHaveBeenCalled();
  });
});
