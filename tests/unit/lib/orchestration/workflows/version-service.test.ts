/**
 * Unit Tests: workflow version-service
 *
 * Covers the behaviour the publish/draft/rollback API surface depends on:
 *
 *   - saveDraft / discardDraft mutate only `draftDefinition`
 *   - publishDraft validates (Zod + structural + semantic) before writing
 *   - publishDraft increments `version` monotonically per workflow
 *   - publishDraft clears draft and pins publishedVersionId inside a single
 *     `$transaction`
 *   - publishDraft emits a `workflow.publish` audit with from/to ints
 *   - rollback rejects unknown / cross-workflow target version ids
 *   - rollback creates a NEW version (history is monotonic, never rewritten)
 *   - listVersions paginates correctly and exposes nextCursor
 *   - getVersion 404s on unknown
 *   - createInitialVersion runs inside a caller-provided transaction
 *
 * @see lib/orchestration/workflows/version-service.ts
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ─── Mocks (must come before module imports) ───────────────────────────────

const txState = {
  versionFindFirst: vi.fn(),
  versionCreate: vi.fn(),
  workflowUpdate: vi.fn(),
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
      findUnique: vi.fn(),
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
        aiWorkflow: { update: txState.workflowUpdate },
        aiWorkflowVersion: {
          findFirst: txState.versionFindFirst,
          create: txState.versionCreate,
        },
      })
    ),
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/orchestration/workflows/semantic-validator', () => ({
  semanticValidateWorkflow: vi.fn(async () => ({ ok: true, errors: [] })),
}));

// ─── Imports under test ─────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { semanticValidateWorkflow } from '@/lib/orchestration/workflows/semantic-validator';
import {
  saveDraft,
  discardDraft,
  publishDraft,
  rollback,
  createInitialVersion,
  listVersions,
  getVersion,
} from '@/lib/orchestration/workflows/version-service';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import type { WorkflowDefinition } from '@/types/orchestration';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_WORKFLOW_ID = 'cmjbv4i3x00003wsloputaaaa';
const ADMIN_ID = 'cmjbv4i3x00003wsloputuser';
const VERSION_ID_V1 = 'cmjbv4i3x00003wsloputvv01';
const VERSION_ID_V2 = 'cmjbv4i3x00003wsloputvv02';
const VERSION_ID_NEW = 'cmjbv4i3x00003wsloputvnew';

const VALID_DEF: WorkflowDefinition = {
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
  errorStrategy: 'fail',
};

const ALT_DEF: WorkflowDefinition = {
  steps: [
    {
      id: 'step-2',
      name: 'Step Two',
      type: 'chain',
      config: { prompt: 'hello again' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-2',
  errorStrategy: 'retry',
};

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    publishedVersionId: VERSION_ID_V1,
    draftDefinition: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(semanticValidateWorkflow).mockResolvedValue({ ok: true, errors: [] });
});

// ─── saveDraft ──────────────────────────────────────────────────────────────

describe('saveDraft', () => {
  it('writes draftDefinition without touching publishedVersionId', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );

    await saveDraft({
      workflowId: WORKFLOW_ID,
      definition: ALT_DEF,
      userId: ADMIN_ID,
      clientIp: '127.0.0.1',
    });

    const updateArgs = vi.mocked(prisma.aiWorkflow.update).mock.calls[0]?.[0];
    expect(updateArgs?.where).toEqual({ id: WORKFLOW_ID });
    expect(updateArgs?.data).toEqual({ draftDefinition: ALT_DEF });
    expect(updateArgs?.data).not.toHaveProperty('publishedVersionId');
  });

  it('throws NotFoundError when workflow does not exist', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
    await expect(
      saveDraft({ workflowId: WORKFLOW_ID, definition: VALID_DEF, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('emits a workflow.draft.save audit log', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

    await saveDraft({ workflowId: WORKFLOW_ID, definition: VALID_DEF, userId: ADMIN_ID });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'workflow.draft.save',
        entityType: 'workflow',
        entityId: WORKFLOW_ID,
      })
    );
  });
});

// ─── discardDraft ───────────────────────────────────────────────────────────

describe('discardDraft', () => {
  it('clears draftDefinition only', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: ALT_DEF }) as never
    );
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

    await discardDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID });

    const args = vi.mocked(prisma.aiWorkflow.update).mock.calls[0]?.[0];
    const data = args?.data as Record<string, unknown> | undefined;
    expect(Object.keys(data ?? {})).toEqual(['draftDefinition']);
  });

  it('is idempotent — calling on a workflow with no draft is a safe no-op write', async () => {
    // Admin clicking "Discard draft" twice in a row should not error. The
    // second call is a no-op write to a column that's already null.
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: null }) as never
    );
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

    await expect(
      discardDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID })
    ).resolves.toBeDefined();
    expect(prisma.aiWorkflow.update).toHaveBeenCalledOnce();
  });

  it('emits a workflow.draft.discard audit log', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflow.update).mockResolvedValue(makeWorkflow() as never);

    await discardDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.draft.discard' })
    );
  });
});

// ─── publishDraft ───────────────────────────────────────────────────────────

describe('publishDraft', () => {
  it('throws NotFoundError when workflow does not exist', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when there is no draft', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: null }) as never
    );
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects when the draft fails Zod parse', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: { steps: [] } }) as never // entryStepId missing, no steps
    );
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when the draft fails structural DAG validation', async () => {
    const cycleDef = {
      steps: [
        {
          id: 'a',
          name: 'A',
          type: 'chain',
          config: {},
          nextSteps: [{ targetStepId: 'b' }],
        },
        {
          id: 'b',
          name: 'B',
          type: 'chain',
          config: {},
          nextSteps: [{ targetStepId: 'a' }], // cycle
        },
      ],
      entryStepId: 'a',
      errorStrategy: 'fail',
    };
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: cycleDef }) as never
    );
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when the draft fails semantic validation', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: VALID_DEF }) as never
    );
    vi.mocked(semanticValidateWorkflow).mockResolvedValueOnce({
      ok: false,
      errors: [{ stepId: 'step-1', code: 'INACTIVE_AGENT', message: 'Missing agent' }],
    });
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('increments version monotonically per workflow', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: VALID_DEF, publishedVersionId: VERSION_ID_V2 }) as never
    );
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ id: VERSION_ID_V2, version: 4 }) as never
    );
    txState.versionFindFirst.mockResolvedValue(makeVersion({ version: 4 }));
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 5 }));
    txState.workflowUpdate.mockResolvedValue(
      makeWorkflow({ publishedVersionId: VERSION_ID_NEW, draftDefinition: null })
    );

    const result = await publishDraft({
      workflowId: WORKFLOW_ID,
      userId: ADMIN_ID,
      changeSummary: 'Tweaked the prompt',
    });

    expect(txState.versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 5,
          workflowId: WORKFLOW_ID,
          createdBy: ADMIN_ID,
          changeSummary: 'Tweaked the prompt',
        }),
      })
    );
    expect(result.version.version).toBe(5);
  });

  it('starts at version 1 when no prior version exists', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: VALID_DEF, publishedVersionId: null }) as never
    );
    txState.versionFindFirst.mockResolvedValue(null);
    txState.versionCreate.mockResolvedValue(makeVersion({ version: 1 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID });

    expect(txState.versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 1 }) })
    );
  });

  it('clears draftDefinition and pins publishedVersionId in the same transaction', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: VALID_DEF }) as never
    );
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ id: VERSION_ID_V1, version: 1 }) as never
    );
    txState.versionFindFirst.mockResolvedValue(makeVersion({ version: 1 }));
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 2 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txState.workflowUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WORKFLOW_ID },
        data: expect.objectContaining({ publishedVersionId: VERSION_ID_NEW }),
      })
    );
    const data = txState.workflowUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toHaveProperty('draftDefinition');
  });

  it('emits workflow.publish audit with previous→new version ints', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: VALID_DEF, publishedVersionId: VERSION_ID_V2 }) as never
    );
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ id: VERSION_ID_V2, version: 4 }) as never
    );
    txState.versionFindFirst.mockResolvedValue(makeVersion({ version: 4 }));
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 5 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await publishDraft({
      workflowId: WORKFLOW_ID,
      userId: ADMIN_ID,
      changeSummary: 'Notes',
    });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.publish',
        changes: { publishedVersion: { from: 4, to: 5 } },
        metadata: { changeSummary: 'Notes' },
      })
    );
  });

  it('records previous version as null when nothing was published before', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: VALID_DEF, publishedVersionId: null }) as never
    );
    txState.versionFindFirst.mockResolvedValue(null);
    txState.versionCreate.mockResolvedValue(makeVersion({ version: 1 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.publish',
        changes: { publishedVersion: { from: null, to: 1 } },
      })
    );
  });

  it('does not partially commit if the transaction throws', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ draftDefinition: VALID_DEF }) as never
    );
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('connection lost'));

    await expect(publishDraft({ workflowId: WORKFLOW_ID, userId: ADMIN_ID })).rejects.toThrow(
      'connection lost'
    );
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

// ─── rollback ───────────────────────────────────────────────────────────────

describe('rollback', () => {
  it('throws NotFoundError when workflow does not exist', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);
    await expect(
      rollback({ workflowId: WORKFLOW_ID, targetVersionId: VERSION_ID_V1, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when target version does not exist', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(null);
    await expect(
      rollback({ workflowId: WORKFLOW_ID, targetVersionId: VERSION_ID_V1, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when target version belongs to a different workflow', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ workflowId: OTHER_WORKFLOW_ID }) as never
    );
    await expect(
      rollback({ workflowId: WORKFLOW_ID, targetVersionId: VERSION_ID_V1, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates a NEW version (does not mutate the target row) and pins to it', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ publishedVersionId: VERSION_ID_V2 }) as never
    );
    (prisma.aiWorkflowVersion.findUnique as unknown as Mock).mockImplementation(async (args) => {
      if (
        (args as { where: { id?: string } }).where.id === VERSION_ID_V1 ||
        (args as { where: { workflowId_version?: unknown } }).where.workflowId_version
      ) {
        return makeVersion({ id: VERSION_ID_V1, version: 1 }) as never;
      }
      return makeVersion({ id: VERSION_ID_V2, version: 2 }) as never;
    });
    txState.versionFindFirst.mockResolvedValue(makeVersion({ version: 2 }));
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 3 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow({ publishedVersionId: VERSION_ID_NEW }));

    const result = await rollback({
      workflowId: WORKFLOW_ID,
      targetVersionId: VERSION_ID_V1,
      userId: ADMIN_ID,
    });

    expect(txState.versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 3,
          workflowId: WORKFLOW_ID,
          changeSummary: 'Rollback to v1',
        }),
      })
    );
    expect(result.version.id).toBe(VERSION_ID_NEW);
    expect(result.version.id).not.toBe(VERSION_ID_V1);
  });

  it('rolling back to the currently-published version still creates a NEW version (allowed but visible in audit)', async () => {
    // Edge case: admin rolls back to the same version that's already
    // published. We don't reject this — it's a "freeze the current" gesture
    // that creates a duplicate vN+1 with the same snapshot. The audit
    // trail makes the action visible.
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ publishedVersionId: VERSION_ID_V1 }) as never
    );
    (prisma.aiWorkflowVersion.findUnique as unknown as Mock).mockResolvedValue(
      makeVersion({ id: VERSION_ID_V1, version: 1 })
    );
    txState.versionFindFirst.mockResolvedValue(makeVersion({ version: 1 }));
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 2 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow({ publishedVersionId: VERSION_ID_NEW }));

    await rollback({
      workflowId: WORKFLOW_ID,
      targetVersionId: VERSION_ID_V1,
      userId: ADMIN_ID,
    });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.rollback',
        // from: 1 (the previously-published v1) → to: 2 (the new copy)
        changes: { publishedVersion: { from: 1, to: 2 } },
        metadata: { rolledBackToVersion: 1 },
      })
    );
  });

  it('emits workflow.rollback audit including rolledBackToVersion', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
      makeWorkflow({ publishedVersionId: VERSION_ID_V2 }) as never
    );
    (prisma.aiWorkflowVersion.findUnique as unknown as Mock).mockImplementation(async (args) => {
      const w = (args as { where: { id?: string } }).where.id;
      if (w === VERSION_ID_V1) return makeVersion({ id: VERSION_ID_V1, version: 1 }) as never;
      if (w === VERSION_ID_V2) return makeVersion({ id: VERSION_ID_V2, version: 2 }) as never;
      return null;
    });
    txState.versionFindFirst.mockResolvedValue(makeVersion({ version: 2 }));
    txState.versionCreate.mockResolvedValue(makeVersion({ version: 3 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await rollback({
      workflowId: WORKFLOW_ID,
      targetVersionId: VERSION_ID_V1,
      userId: ADMIN_ID,
    });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.rollback',
        changes: { publishedVersion: { from: 2, to: 3 } },
        metadata: { rolledBackToVersion: 1 },
      })
    );
  });
});

// ─── createInitialVersion ──────────────────────────────────────────────────

describe('createInitialVersion', () => {
  it('inserts version 1 inside the caller-provided transaction', async () => {
    const tx = {
      aiWorkflow: { update: vi.fn().mockResolvedValue(makeWorkflow()) },
      aiWorkflowVersion: { create: vi.fn().mockResolvedValue(makeVersion({ version: 1 })) },
    };

    const result = await createInitialVersion({
      tx: tx as never,
      workflowId: WORKFLOW_ID,
      definition: VALID_DEF,
      userId: ADMIN_ID,
    });

    expect(tx.aiWorkflowVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workflowId: WORKFLOW_ID,
          version: 1,
          createdBy: ADMIN_ID,
          changeSummary: 'Initial version',
        }),
      })
    );
    expect(tx.aiWorkflow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WORKFLOW_ID },
        data: { publishedVersionId: result.id },
      })
    );
    // Top-level prisma must NOT have been called — the caller owns the tx
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── listVersions ──────────────────────────────────────────────────────────

describe('listVersions', () => {
  it('returns versions in descending order with no cursor when fewer than limit+1', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findMany).mockResolvedValue([
      makeVersion({ id: 'v3', version: 3 }),
      makeVersion({ id: 'v2', version: 2 }),
    ] as never);

    const result = await listVersions(WORKFLOW_ID, { limit: 50 });

    expect(result.nextCursor).toBeNull();
    expect(result.versions).toHaveLength(2);
    const findManyArgs = vi.mocked(prisma.aiWorkflowVersion.findMany).mock.calls[0]?.[0];
    expect(findManyArgs?.orderBy).toEqual({ version: 'desc' });
  });

  it('exposes a nextCursor when there are more rows than the limit', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findMany).mockResolvedValue([
      makeVersion({ id: 'v3', version: 3 }),
      makeVersion({ id: 'v2', version: 2 }),
      makeVersion({ id: 'v1-extra', version: 1 }),
    ] as never);

    const result = await listVersions(WORKFLOW_ID, { limit: 2 });

    expect(result.versions).toHaveLength(2);
    expect(result.nextCursor).toBe('v2');
  });

  it('clamps limit to the [1, 100] range', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findMany).mockResolvedValue([] as never);

    await listVersions(WORKFLOW_ID, { limit: 9999 });
    const args1 = vi.mocked(prisma.aiWorkflowVersion.findMany).mock.calls[0]?.[0];
    expect(args1?.take).toBe(101);

    vi.mocked(prisma.aiWorkflowVersion.findMany).mockClear();
    await listVersions(WORKFLOW_ID, { limit: 0 });
    const args2 = vi.mocked(prisma.aiWorkflowVersion.findMany).mock.calls[0]?.[0];
    expect(args2?.take).toBe(2);
  });
});

// ─── getVersion ────────────────────────────────────────────────────────────

describe('getVersion', () => {
  it('returns the version row when it exists', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ version: 7 }) as never
    );
    const v = await getVersion(WORKFLOW_ID, 7);
    expect(v.version).toBe(7);
  });

  it('throws NotFoundError when the version does not exist', async () => {
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(null);
    await expect(getVersion(WORKFLOW_ID, 999)).rejects.toBeInstanceOf(NotFoundError);
  });
});
