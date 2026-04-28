/**
 * Tests: Workflow Templates List & Save-as-Template
 *
 * GET  /api/v1/admin/orchestration/workflows/templates
 * POST /api/v1/admin/orchestration/workflows/:id/save-as-template
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET as ListTemplates } from '@/app/api/v1/admin/orchestration/workflows/templates/route';
import { POST as SaveAsTemplate } from '@/app/api/v1/admin/orchestration/workflows/[id]/save-as-template/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Test Template',
    slug: 'test-template',
    description: 'A test template',
    patternsUsed: [1, 2],
    templateSource: 'builtin',
    metadata: { useCases: ['customer-support'] },
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'My Workflow',
    slug: 'my-workflow',
    description: 'A workflow',
    workflowDefinition: { steps: [] },
    workflowDefinitionHistory: [],
    patternsUsed: [3],
    isActive: true,
    isTemplate: false,
    templateSource: null,
    metadata: {},
    createdBy: 'admin-1',
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeListRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/workflows/templates');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeSaveRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/save-as-template`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /workflows/templates', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await ListTemplates(makeListRequest());
    expect(response.status).toBe(401);
  });

  it('returns paginated templates', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([
      makeTemplate(),
      makeTemplate({ id: 'id2', name: 'Custom', templateSource: 'custom' }),
    ] as never);
    vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(2);

    const response = await ListTemplates(makeListRequest());
    expect(response.status).toBe(200);

    const data = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(data.data).toHaveLength(2);
    expect(data.meta.total).toBe(2);
  });

  it('filters by source when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(0);

    await ListTemplates(makeListRequest({ source: 'custom' }));

    expect(vi.mocked(prisma.aiWorkflow.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ templateSource: 'custom' }),
      })
    );
  });

  it('filters templates by isTemplate: true', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(0);

    await ListTemplates(makeListRequest());

    expect(vi.mocked(prisma.aiWorkflow.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isTemplate: true }),
      })
    );
  });
});

describe('POST /workflows/:id/save-as-template', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await SaveAsTemplate(makeSaveRequest(), makeParams(WORKFLOW_ID));
    expect(response.status).toBe(401);
  });

  it('returns 404 when workflow does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

    const response = await SaveAsTemplate(makeSaveRequest(), makeParams(WORKFLOW_ID));
    expect(response.status).toBe(404);
  });

  it('creates a template from an existing workflow', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique)
      .mockResolvedValueOnce(makeWorkflow() as never) // workflow lookup
      .mockResolvedValueOnce(null as never); // slug uniqueness check
    vi.mocked(prisma.aiWorkflow.create).mockResolvedValue(
      makeTemplate({
        templateSource: 'custom',
        name: 'My Workflow (Template)',
        slug: 'my-workflow-template',
      }) as never
    );

    const response = await SaveAsTemplate(makeSaveRequest(), makeParams(WORKFLOW_ID));
    expect(response.status).toBe(200);

    expect(vi.mocked(prisma.aiWorkflow.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isTemplate: true,
          templateSource: 'custom',
          workflowDefinitionHistory: [],
        }),
      })
    );
  });

  it('uses custom name and description when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique)
      .mockResolvedValueOnce(makeWorkflow() as never)
      .mockResolvedValueOnce(null as never);
    vi.mocked(prisma.aiWorkflow.create).mockResolvedValue(makeTemplate() as never);

    await SaveAsTemplate(
      makeSaveRequest({ name: 'Custom Name', description: 'Custom description' }),
      makeParams(WORKFLOW_ID)
    );

    expect(vi.mocked(prisma.aiWorkflow.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Custom Name',
          description: 'Custom description',
        }),
      })
    );
  });
});
