/**
 * Integration Test: Workflow versioning (publish / draft / rollback)
 *
 * Covers the routes added by `.context/orchestration/meta/improvement-priorities.md`
 * item 12 alongside the PATCH and execute changes:
 *
 *   PATCH  /workflows/:id              — writes to draftDefinition
 *   POST   /workflows/:id/publish      — promote draft to a new version
 *   POST   /workflows/:id/discard-draft
 *   POST   /workflows/:id/rollback     — copy a target version forward
 *   GET    /workflows/:id/versions
 *   GET    /workflows/:id/versions/:version
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/{publish,discard-draft,rollback,versions}
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mocks (must come before route imports) ────────────────────────────────

const txMocks = {
  workflowUpdate: vi.fn(),
  versionFindFirst: vi.fn(),
  versionCreate: vi.fn(),
};

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    aiWorkflowVersion: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        aiWorkflow: { update: txMocks.workflowUpdate },
        aiWorkflowVersion: {
          findFirst: txMocks.versionFindFirst,
          create: txMocks.versionCreate,
        },
      })
    ),
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
  computeChanges: vi.fn(() => null),
}));

// Semantic validation hits the DB; stub it to "ok" by default.
vi.mock('@/lib/orchestration/workflows/semantic-validator', () => ({
  semanticValidateWorkflow: vi.fn(async () => ({ ok: true, errors: [] })),
}));

// ─── Imports under test ────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { semanticValidateWorkflow } from '@/lib/orchestration/workflows/semantic-validator';

import { PATCH as WORKFLOW_PATCH } from '@/app/api/v1/admin/orchestration/workflows/[id]/route';
import { POST as PUBLISH } from '@/app/api/v1/admin/orchestration/workflows/[id]/publish/route';
import { POST as DISCARD } from '@/app/api/v1/admin/orchestration/workflows/[id]/discard-draft/route';
import { POST as ROLLBACK } from '@/app/api/v1/admin/orchestration/workflows/[id]/rollback/route';
import { GET as LIST_VERSIONS } from '@/app/api/v1/admin/orchestration/workflows/[id]/versions/route';
import { GET as GET_VERSION } from '@/app/api/v1/admin/orchestration/workflows/[id]/versions/[version]/route';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_WORKFLOW_ID = 'cmjbv4i3x00003wsloputaaaa';
const ADMIN_ID = 'cmjbv4i3x00003wsloputuser';
const VERSION_ID_V1 = 'cmjbv4i3x00003wsloputvv01';
const VERSION_ID_V2 = 'cmjbv4i3x00003wsloputvv02';
const VERSION_ID_NEW = 'cmjbv4i3x00003wsloputvnew';

const VALID_DEF = {
  steps: [
    {
      id: 'step-1',
      name: 'Step One',
      type: 'chain',
      config: { prompt: 'hello' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail' as const,
};

const ALT_DEF = {
  ...VALID_DEF,
  steps: [{ ...VALID_DEF.steps[0], id: 'step-2' }],
  entryStepId: 'step-2',
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    isActive: true,
    isTemplate: false,
    isSystem: false,
    publishedVersionId: VERSION_ID_V1,
    draftDefinition: null,
    patternsUsed: [],
    templateSource: null,
    metadata: {},
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID_V1,
    workflowId: WORKFLOW_ID,
    version: 1,
    snapshot: VALID_DEF as unknown,
    changeSummary: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeRequest(method: 'POST' | 'PATCH' | 'GET', path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
  });
}

function makeParams(workflowId: string = WORKFLOW_ID) {
  return { params: Promise.resolve({ id: workflowId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminLimiter.check).mockReturnValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: 9999999999,
  });
  vi.mocked(semanticValidateWorkflow).mockResolvedValue({ ok: true, errors: [] });
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
});

// ─── PATCH: writes to draft ────────────────────────────────────────────────

describe('PATCH /workflows/:id with draftDefinition', () => {
  it('writes to draftDefinition and emits workflow.draft.save', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflow.findUniqueOrThrow).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );

    const res = await WORKFLOW_PATCH(
      makeRequest('PATCH', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}`, {
        draftDefinition: ALT_DEF,
      }),
      makeParams()
    );

    expect(res.status).toBe(200);
    // The draft-save audit is emitted by the version-service (saveDraft).
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.draft.save' })
    );
  });

  it('clears the draft when draftDefinition is null', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );
    vi.mocked(prisma.aiWorkflow.findUniqueOrThrow).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

    const res = await WORKFLOW_PATCH(
      makeRequest('PATCH', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}`, {
        draftDefinition: null,
      }),
      makeParams()
    );

    expect(res.status).toBe(200);
  });

  it('does NOT emit a redundant workflow.update audit when only draftDefinition was sent', async () => {
    // saveDraft fires workflow.draft.save; if the route then runs an empty
    // prisma.aiWorkflow.update + workflow.update audit, the same change is
    // logged twice. That regressed once before — lock the behaviour.
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflow.findUniqueOrThrow).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );

    const res = await WORKFLOW_PATCH(
      makeRequest('PATCH', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}`, {
        draftDefinition: ALT_DEF,
      }),
      makeParams()
    );

    expect(res.status).toBe(200);
    const actions = vi
      .mocked(logAdminAction)
      .mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain('workflow.draft.save');
    expect(actions).not.toContain('workflow.update');
  });

  it('emits BOTH audits when name and draftDefinition are sent together', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
      makeWorkflow({ name: 'Renamed', draftDefinition: ALT_DEF }) as never
    );

    const res = await WORKFLOW_PATCH(
      makeRequest('PATCH', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}`, {
        name: 'Renamed',
        draftDefinition: ALT_DEF,
      }),
      makeParams()
    );

    expect(res.status).toBe(200);
    const actions = vi
      .mocked(logAdminAction)
      .mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain('workflow.draft.save');
    expect(actions).toContain('workflow.update');
  });

  it('401s without admin session', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await WORKFLOW_PATCH(
      makeRequest('PATCH', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}`, {
        draftDefinition: ALT_DEF,
      }),
      makeParams()
    );
    expect(res.status).toBe(401);
  });
});

// ─── POST /publish ─────────────────────────────────────────────────────────

describe('POST /workflows/:id/publish', () => {
  beforeEach(() => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ id: VERSION_ID_V1, version: 1 }) as never
    );
    txMocks.versionFindFirst.mockResolvedValue(makeVersion({ version: 1 }));
    txMocks.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 2 }));
    txMocks.workflowUpdate.mockResolvedValue(makeWorkflow({ publishedVersionId: VERSION_ID_NEW }));
  });

  it('happy path: draft → vN+1 with workflow.publish audit', async () => {
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/publish`, {
        changeSummary: 'Tweak',
      }),
      makeParams()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { version: { version: number } } };
    expect(body.data.version.version).toBe(2);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.publish',
        changes: { publishedVersion: { from: 1, to: 2 } },
      })
    );
  });

  it('400s when there is no draft', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: null }) as never
    );
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/publish`, {}),
      makeParams()
    );
    expect(res.status).toBe(400);
  });

  it('400s when the draft fails Zod parse', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: { steps: [] } }) as never // entryStepId missing
    );
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/publish`, {}),
      makeParams()
    );
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('400s when the draft fails semantic validation', async () => {
    vi.mocked(semanticValidateWorkflow).mockResolvedValueOnce({
      ok: false,
      errors: [{ stepId: 'step-1', code: 'INACTIVE_AGENT', message: 'Agent inactive' }],
    });
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/publish`, {}),
      makeParams()
    );
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not partially commit if the transaction throws', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('connection lost'));
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/publish`, {}),
      makeParams()
    );
    expect(res.status).toBe(500);
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('401s without admin session', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/publish`, {}),
      makeParams()
    );
    expect(res.status).toBe(401);
  });

  it('403s when the session is not an admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/publish`, {}),
      makeParams()
    );
    expect(res.status).toBe(403);
  });

  it('429s when rate limited', async () => {
    vi.mocked(adminLimiter.check).mockReturnValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60000,
    });
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/publish`, {}),
      makeParams()
    );
    expect(res.status).toBe(429);
  });

  it('400s for an invalid workflow id', async () => {
    const res = await PUBLISH(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/not-a-cuid/publish`, {}),
      { params: Promise.resolve({ id: 'not-a-cuid' }) }
    );
    expect(res.status).toBe(400);
  });
});

// ─── POST /discard-draft ───────────────────────────────────────────────────

describe('POST /workflows/:id/discard-draft', () => {
  it('clears the draft and emits workflow.draft.discard', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

    const res = await DISCARD(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/discard-draft`),
      makeParams()
    );

    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.draft.discard' })
    );
    // No new version should have been created.
    expect(prisma.aiWorkflowVersion.create).not.toHaveBeenCalled();
  });

  it('401s without admin session', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await DISCARD(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/discard-draft`),
      makeParams()
    );
    expect(res.status).toBe(401);
  });

  it('429s when rate limited', async () => {
    vi.mocked(adminLimiter.check).mockReturnValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    const res = await DISCARD(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/discard-draft`),
      makeParams()
    );
    expect(res.status).toBe(429);
  });

  it('400s for an invalid workflow id', async () => {
    const res = await DISCARD(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/not-a-cuid/discard-draft`),
      { params: Promise.resolve({ id: 'not-a-cuid' }) }
    );
    expect(res.status).toBe(400);
  });
});

// ─── POST /rollback ────────────────────────────────────────────────────────

describe('POST /workflows/:id/rollback', () => {
  beforeEach(() => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ publishedVersionId: VERSION_ID_V2 }) as never
    );
    txMocks.versionFindFirst.mockResolvedValue(makeVersion({ version: 2 }));
    txMocks.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 3 }));
    txMocks.workflowUpdate.mockResolvedValue(makeWorkflow({ publishedVersionId: VERSION_ID_NEW }));
  });

  it('happy path: creates a NEW version copied from the target', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockImplementation((async (args: unknown) => {
      const w = (args as { where: { id?: string } }).where.id;
      if (w === VERSION_ID_V1) return makeVersion({ id: VERSION_ID_V1, version: 1 });
      if (w === VERSION_ID_V2) return makeVersion({ id: VERSION_ID_V2, version: 2 });
      return null;
    }) as never);

    const res = await ROLLBACK(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/rollback`, {
        targetVersionId: VERSION_ID_V1,
      }),
      makeParams()
    );

    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.rollback',
        changes: { publishedVersion: { from: 2, to: 3 } },
        metadata: { rolledBackToVersion: 1 },
      })
    );
  });

  it('404s for an unknown targetVersionId', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(null);
    const res = await ROLLBACK(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/rollback`, {
        targetVersionId: VERSION_ID_V1,
      }),
      makeParams()
    );
    expect(res.status).toBe(404);
  });

  it('400s when the target version belongs to a different workflow', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ id: VERSION_ID_V1, workflowId: OTHER_WORKFLOW_ID }) as never
    );
    const res = await ROLLBACK(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/rollback`, {
        targetVersionId: VERSION_ID_V1,
      }),
      makeParams()
    );
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('400s when targetVersionId is missing', async () => {
    const res = await ROLLBACK(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/rollback`, {}),
      makeParams()
    );
    expect(res.status).toBe(400);
  });

  it('accepts a UUID-format targetVersionId (backfilled rows from the migration)', async () => {
    // Backfilled version rows have UUID ids from `gen_random_uuid()::text` in
    // the migration's PL/pgSQL block. Validating with cuidSchema would reject
    // them — workflowVersionIdSchema accepts both formats.
    const UUID_VERSION_ID = '90740b81-9e64-4839-8036-e800bb2ed143';
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ publishedVersionId: VERSION_ID_V2 }) as never
    );
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockImplementation((async (args: unknown) => {
      const w = (args as { where: { id?: string } }).where.id;
      if (w === UUID_VERSION_ID) return makeVersion({ id: UUID_VERSION_ID, version: 1 });
      if (w === VERSION_ID_V2) return makeVersion({ id: VERSION_ID_V2, version: 2 });
      return null;
    }) as never);

    const res = await ROLLBACK(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/rollback`, {
        targetVersionId: UUID_VERSION_ID,
      }),
      makeParams()
    );
    expect(res.status).toBe(200);
  });

  it('400s for a malformed targetVersionId (neither CUID nor UUID)', async () => {
    const res = await ROLLBACK(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/rollback`, {
        targetVersionId: 'not-a-version-id',
      }),
      makeParams()
    );
    expect(res.status).toBe(400);
  });

  it('429s when rate limited', async () => {
    vi.mocked(adminLimiter.check).mockReturnValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    const res = await ROLLBACK(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/rollback`, {
        targetVersionId: VERSION_ID_V1,
      }),
      makeParams()
    );
    expect(res.status).toBe(429);
  });

  it('400s for an invalid workflow id', async () => {
    const res = await ROLLBACK(
      makeRequest('POST', `/api/v1/admin/orchestration/workflows/not-a-cuid/rollback`, {
        targetVersionId: VERSION_ID_V1,
      }),
      { params: Promise.resolve({ id: 'not-a-cuid' }) }
    );
    expect(res.status).toBe(400);
  });
});

// ─── GET /versions ─────────────────────────────────────────────────────────

describe('GET /workflows/:id/versions', () => {
  it('returns versions descending by version int', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflowVersion.findMany).mockResolvedValue([
      makeVersion({ id: 'v3', version: 3 }),
      makeVersion({ id: 'v2', version: 2 }),
      makeVersion({ id: 'v1', version: 1 }),
    ] as never);

    const res = await LIST_VERSIONS(
      makeRequest('GET', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/versions`),
      makeParams()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { versions: Array<{ version: number }>; publishedVersionId: string };
    };
    expect(body.data.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(body.data.publishedVersionId).toBe(VERSION_ID_V1);
  });

  it('exposes nextCursor when there are more rows than the limit', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    // Service requests `limit + 1`; return that many to signal "more".
    vi.mocked(prisma.aiWorkflowVersion.findMany).mockResolvedValue([
      makeVersion({ id: 'v3', version: 3 }),
      makeVersion({ id: 'v2', version: 2 }),
      makeVersion({ id: 'v1', version: 1 }),
    ] as never);

    const res = await LIST_VERSIONS(
      makeRequest('GET', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/versions?limit=2`),
      makeParams()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { versions: unknown[]; nextCursor: string | null };
    };
    expect(body.data.versions).toHaveLength(2);
    expect(body.data.nextCursor).toBe('v2');
  });

  it('404s when the workflow does not exist', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
    const res = await LIST_VERSIONS(
      makeRequest('GET', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/versions`),
      makeParams()
    );
    expect(res.status).toBe(404);
  });

  it('429s when rate limited', async () => {
    vi.mocked(adminLimiter.check).mockReturnValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    const res = await LIST_VERSIONS(
      makeRequest('GET', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/versions`),
      makeParams()
    );
    expect(res.status).toBe(429);
  });
});

// ─── GET /versions/:version ────────────────────────────────────────────────

describe('GET /workflows/:id/versions/:version', () => {
  it('returns the version row when present', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ version: 7 }) as never
    );
    const res = await GET_VERSION(
      makeRequest('GET', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/versions/7`),
      { params: Promise.resolve({ id: WORKFLOW_ID, version: '7' }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { version: number } };
    expect(body.data.version).toBe(7);
  });

  it('404s for an unknown version', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(null);
    const res = await GET_VERSION(
      makeRequest('GET', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/versions/99`),
      { params: Promise.resolve({ id: WORKFLOW_ID, version: '99' }) }
    );
    expect(res.status).toBe(404);
  });

  it('400s when version param is not a positive integer', async () => {
    const res = await GET_VERSION(
      makeRequest('GET', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/versions/abc`),
      { params: Promise.resolve({ id: WORKFLOW_ID, version: 'abc' }) }
    );
    expect(res.status).toBe(400);
  });

  it('429s when rate limited', async () => {
    vi.mocked(adminLimiter.check).mockReturnValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    const res = await GET_VERSION(
      makeRequest('GET', `/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/versions/1`),
      { params: Promise.resolve({ id: WORKFLOW_ID, version: '1' }) }
    );
    expect(res.status).toBe(429);
  });
});
