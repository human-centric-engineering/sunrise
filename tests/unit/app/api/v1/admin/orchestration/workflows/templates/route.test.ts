/**
 * Tests: Workflow Templates List & Save-as-Template
 *
 * GET  /api/v1/admin/orchestration/workflows/templates — built-ins from code + the org's own
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

// Shared transaction-internal mock fns so tests can assert on the tx writes.
const txMocks = {
  workflowCreate: vi.fn(),
  workflowUpdate: vi.fn(),
  workflowFindUniqueOrThrow: vi.fn(),
  versionCreate: vi.fn(),
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    aiWorkflowVersion: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        aiWorkflow: {
          create: txMocks.workflowCreate,
          update: txMocks.workflowUpdate,
          findUniqueOrThrow: txMocks.workflowFindUniqueOrThrow,
        },
        aiWorkflowVersion: { create: txMocks.versionCreate },
      })
    ),
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@/prisma/seeds/data/templates';
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
  const VALID_DEF = {
    steps: [
      {
        id: 's1',
        name: 'S1',
        type: 'chain',
        config: { prompt: 'hi' },
        nextSteps: [],
      },
    ],
    entryStepId: 's1',
    errorStrategy: 'fail',
  };
  return {
    id: WORKFLOW_ID,
    name: 'My Workflow',
    slug: 'my-workflow',
    description: 'A workflow',
    draftDefinition: null,
    publishedVersionId: 'wfv-1',
    publishedVersion: { id: 'wfv-1', version: 1, snapshot: VALID_DEF },
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
  type Entry = {
    source: 'builtin' | 'custom';
    slug: string;
    name: string;
    description: string;
    workflowDefinition: unknown;
    patternsUsed: number[];
    metadata: unknown;
  };

  function customRow(overrides: Record<string, unknown> = {}) {
    return {
      slug: 'my-template',
      name: 'My Template',
      description: 'An org template',
      patternsUsed: [3],
      metadata: { flowSummary: 'x' },
      publishedVersion: { snapshot: { steps: [], entryStepId: 's1', errorStrategy: 'fail' } },
      ...overrides,
    };
  }

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await ListTemplates(makeListRequest());
    expect(response.status).toBe(401);
  });

  it("serves every built-in from code, in code order, before the org's own", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([customRow()] as never);

    const response = await ListTemplates(makeListRequest());
    expect(response.status).toBe(200);
    const { data } = await parseJson<{ data: Entry[] }>(response);

    const builtins = data.filter((e) => e.source === 'builtin');
    expect(builtins.map((e) => e.slug)).toEqual(BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.slug));
    expect(builtins).toHaveLength(12);
    // The entry is the code definition, not a row: its DAG and metadata are
    // the template's own.
    const first = BUILTIN_WORKFLOW_TEMPLATES[0];
    expect(builtins[0]).toEqual({
      source: 'builtin',
      slug: first.slug,
      name: first.name,
      description: first.shortDescription,
      workflowDefinition: JSON.parse(JSON.stringify(first.workflowDefinition)),
      patternsUsed: first.patterns.map((p) => p.number),
      metadata: JSON.parse(
        JSON.stringify({
          flowSummary: first.flowSummary,
          useCases: first.useCases,
          patterns: first.patterns,
        })
      ),
    });
    expect(data.at(-1)).toMatchObject({ source: 'custom', slug: 'my-template' });
    expect(data).toHaveLength(13);
  });

  it("reads the org's own templates through the tenant client, leaving out built-in slugs", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);

    await ListTemplates(makeListRequest());

    // `prisma` here is the chokepoint client, which confines the read to the
    // caller's org at multi (the tenancy smoke proves that against Postgres).
    // The route adds no org filter and no system scope of its own.
    expect(prisma.aiWorkflow.findMany).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.aiWorkflow.findMany).mock.calls[0][0] as {
      where: { isTemplate: boolean; slug: { notIn: string[] }; orgId?: unknown };
      take: number;
    };
    expect(args.where.isTemplate).toBe(true);
    // A retired seed row an admin switched back on must not appear twice.
    expect([...args.where.slug.notIn].sort()).toEqual(
      BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.slug).sort()
    );
    expect(args.where).not.toHaveProperty('orgId');
    // One past the cap, so a list the cap cuts short can say so.
    expect(args.take).toBe(101);
  });

  it('maps a custom row to its published snapshot, or null without one', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([
      customRow(),
      customRow({ slug: 'unpublished', name: 'Unpublished', publishedVersion: null }),
    ] as never);

    const response = await ListTemplates(makeListRequest({ source: 'custom' }));
    const { data } = await parseJson<{ data: Entry[] }>(response);

    expect(data).toEqual([
      {
        source: 'custom',
        slug: 'my-template',
        name: 'My Template',
        description: 'An org template',
        workflowDefinition: { steps: [], entryStepId: 's1', errorStrategy: 'fail' },
        patternsUsed: [3],
        metadata: { flowSummary: 'x' },
      },
      expect.objectContaining({ slug: 'unpublished', workflowDefinition: null }),
    ]);
  });

  it("returns at most 100 of the org's own and flags a list the cap cut short", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const rows = Array.from({ length: 101 }, (_, i) =>
      customRow({ slug: `own-${String(i).padStart(3, '0')}`, name: `Own ${i}` })
    );
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue(rows as never);

    const response = await ListTemplates(makeListRequest({ source: 'custom' }));
    const body = await parseJson<{ data: Entry[]; meta: { customTruncated: boolean } }>(response);

    expect(body.data).toHaveLength(100);
    expect(body.data.at(-1)?.slug).toBe('own-099');
    expect(body.meta.customTruncated).toBe(true);

    // Exactly at the cap is the whole list, not a truncated one.
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue(rows.slice(0, 100) as never);
    const whole = await parseJson<{ data: Entry[]; meta: { customTruncated: boolean } }>(
      await ListTemplates(makeListRequest({ source: 'custom' }))
    );
    expect(whole.data).toHaveLength(100);
    expect(whole.meta.customTruncated).toBe(false);
  });

  it('source=builtin serves the built-ins without touching the database', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await ListTemplates(makeListRequest({ source: 'builtin' }));
    const { data } = await parseJson<{ data: Entry[] }>(response);

    expect(data).toHaveLength(12);
    expect(data.every((e) => e.source === 'builtin')).toBe(true);
    expect(prisma.aiWorkflow.findMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown source with 400', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await ListTemplates(makeListRequest({ source: 'everything' }));

    expect(response.status).toBe(400);
    expect(prisma.aiWorkflow.findMany).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(null); // slug uniqueness check
    txMocks.workflowCreate.mockResolvedValueOnce({ id: 'wf-new' });
    txMocks.versionCreate.mockResolvedValueOnce({ id: 'wfv-new', version: 1 });
    txMocks.workflowFindUniqueOrThrow.mockResolvedValueOnce(
      makeTemplate({
        templateSource: 'custom',
        name: 'My Workflow (Template)',
        slug: 'my-workflow-template',
      })
    );

    const response = await SaveAsTemplate(makeSaveRequest(), makeParams(WORKFLOW_ID));
    expect(response.status).toBe(200);

    // The route writes inside a transaction; the new template row gets
    // isTemplate / templateSource / no inherited history. Workflow definition
    // history is no longer a column — versioning replaces it.
    expect(txMocks.workflowCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isTemplate: true,
          templateSource: 'custom',
        }),
      })
    );
    // The transaction also seeds v1 of the new template via createInitialVersion.
    expect(txMocks.versionCreate).toHaveBeenCalledOnce();
  });

  it('uses custom name and description when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflow.findUnique)
      .mockResolvedValueOnce(makeWorkflow() as never)
      .mockResolvedValueOnce(null);
    txMocks.workflowCreate.mockResolvedValueOnce({ id: 'wf-new' });
    txMocks.versionCreate.mockResolvedValueOnce({ id: 'wfv-new', version: 1 });
    txMocks.workflowFindUniqueOrThrow.mockResolvedValueOnce(makeTemplate());

    await SaveAsTemplate(
      makeSaveRequest({ name: 'Custom Name', description: 'Custom description' }),
      makeParams(WORKFLOW_ID)
    );

    expect(txMocks.workflowCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Custom Name',
          description: 'Custom description',
        }),
      })
    );
  });
});
