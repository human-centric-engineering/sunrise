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
 *   - save / publish / discard carry the definition version the builder
 *     loaded and are refused with 412 once it moved on; rollback re-reads its
 *     target under erasure's locks (§122 t-900)
 *
 * @see lib/orchestration/workflows/version-service.ts
 */

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ─── Mocks (must come before module imports) ───────────────────────────────

const txState = {
  versionFindFirst: vi.fn(),
  versionCreate: vi.fn(),
  workflowUpdate: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  workflowFindUniqueOrThrow: vi.fn(),
  versionFindUnique: vi.fn(),
  receiptFindMany: vi.fn(),
  userFindMany: vi.fn(),
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
        $executeRaw: txState.executeRaw,
        $queryRaw: txState.queryRaw,
        dataErasureReceipt: { findMany: txState.receiptFindMany },
        user: { findMany: txState.userFindMany },
        aiWorkflow: {
          update: txState.workflowUpdate,
          findUniqueOrThrow: txState.workflowFindUniqueOrThrow,
        },
        aiWorkflowVersion: {
          findFirst: txState.versionFindFirst,
          create: txState.versionCreate,
          findUnique: txState.versionFindUnique,
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
import { NotFoundError, StaleRecordError, ValidationError } from '@/lib/api/errors';
import {
  publishedSnapshotVersion,
  workflowDefinitionVersion,
} from '@/lib/orchestration/config-versions';
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

/**
 * The workflow as stored, read both outside the lock and under it: tests that
 * change it under the lock set `txState.workflowFindUniqueOrThrow` after.
 */
let stored: ReturnType<typeof makeWorkflow> | null = null;
function given(workflow: ReturnType<typeof makeWorkflow> | null) {
  stored = workflow;
  vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(workflow as never);
}
function versionOf(workflow: Record<string, unknown>): string {
  return workflowDefinitionVersion({
    draftDefinition: workflow.draftDefinition ?? null,
    publishedVersionId: (workflow.publishedVersionId ?? null) as string | null,
    publishedVersion: null,
  });
}
/** `If-Match` from a builder that loaded the workflow as stored now. */
function current(): string[] {
  return [stored ? versionOf(stored) : '"none"'];
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  txState.queryRaw.mockResolvedValue([]);
  txState.workflowFindUniqueOrThrow.mockImplementation(async () => stored);
  // A rollback's second read of its target: unchanged since the first.
  txState.versionFindUnique.mockImplementation(
    async () => vi.mocked(prisma.aiWorkflowVersion.findUnique).mock.results[0]?.value
  );
  txState.executeRaw.mockResolvedValue(1);
  txState.receiptFindMany.mockResolvedValue([]);
  txState.userFindMany.mockResolvedValue([]);
  vi.mocked(semanticValidateWorkflow).mockResolvedValue({ ok: true, errors: [] });
});

// ─── saveDraft ──────────────────────────────────────────────────────────────

describe('saveDraft', () => {
  it('writes draftDefinition without touching publishedVersionId', async () => {
    given(makeWorkflow());
    txState.workflowUpdate.mockResolvedValue(makeWorkflow({ draftDefinition: ALT_DEF }));

    await saveDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
      definition: ALT_DEF,
      userId: ADMIN_ID,
      clientIp: '127.0.0.1',
    });

    // Written through the transaction client, not the bare one (t-805)
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.aiWorkflow.update).not.toHaveBeenCalled();
    const updateArgs = txState.workflowUpdate.mock.calls[0]?.[0];
    expect(updateArgs?.where).toEqual({ id: WORKFLOW_ID });
    expect(updateArgs?.data).toEqual({ draftDefinition: ALT_DEF });
    expect(updateArgs?.data).not.toHaveProperty('publishedVersionId');
  });

  it('throws NotFoundError when workflow does not exist', async () => {
    given(null);
    await expect(
      saveDraft({
        workflowId: WORKFLOW_ID,
        loadedAt: current(),
        definition: VALID_DEF,
        userId: ADMIN_ID,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('emits a workflow.draft.save audit log', async () => {
    given(makeWorkflow());
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await saveDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
      definition: VALID_DEF,
      userId: ADMIN_ID,
    });

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
    given(makeWorkflow({ draftDefinition: ALT_DEF }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await discardDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID });

    const args = txState.workflowUpdate.mock.calls[0]?.[0];
    const data = args?.data as Record<string, unknown> | undefined;
    expect(Object.keys(data ?? {})).toEqual(['draftDefinition']);
  });

  it('is idempotent — calling on a workflow with no draft is a safe no-op write', async () => {
    // Admin clicking "Discard draft" twice in a row should not error. The
    // second call is a no-op write to a column that's already null.
    given(makeWorkflow({ draftDefinition: null }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await expect(
      discardDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID })
    ).resolves.toBeDefined();
    expect(txState.workflowUpdate).toHaveBeenCalledOnce();
  });

  it('emits a workflow.draft.discard audit log', async () => {
    given(makeWorkflow());
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await discardDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.draft.discard' })
    );
  });
});

// ─── publishDraft ───────────────────────────────────────────────────────────

describe('publishDraft', () => {
  it('throws NotFoundError when workflow does not exist', async () => {
    given(null);
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when there is no draft', async () => {
    given(makeWorkflow({ draftDefinition: null }));
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects when the draft fails Zod parse', async () => {
    given(makeWorkflow({ draftDefinition: { steps: [] } })); // entryStepId missing, no steps
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID })
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
    given(makeWorkflow({ draftDefinition: cycleDef }));
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when the draft fails semantic validation', async () => {
    given(makeWorkflow({ draftDefinition: VALID_DEF }));
    vi.mocked(semanticValidateWorkflow).mockResolvedValueOnce({
      ok: false,
      errors: [{ stepId: 'step-1', code: 'INACTIVE_AGENT', message: 'Missing agent' }],
    });
    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('increments version monotonically per workflow', async () => {
    given(makeWorkflow({ draftDefinition: VALID_DEF, publishedVersionId: VERSION_ID_V2 }));
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
      loadedAt: current(),
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
    given(makeWorkflow({ draftDefinition: VALID_DEF, publishedVersionId: null }));
    txState.versionFindFirst.mockResolvedValue(null);
    txState.versionCreate.mockResolvedValue(makeVersion({ version: 1 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID });

    expect(txState.versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 1 }) })
    );
  });

  it('clears draftDefinition and pins publishedVersionId in the same transaction', async () => {
    given(makeWorkflow({ draftDefinition: VALID_DEF }));
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ id: VERSION_ID_V1, version: 1 }) as never
    );
    txState.versionFindFirst.mockResolvedValue(makeVersion({ version: 1 }));
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 2 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID });

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
    given(makeWorkflow({ draftDefinition: VALID_DEF, publishedVersionId: VERSION_ID_V2 }));
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ id: VERSION_ID_V2, version: 4 }) as never
    );
    txState.versionFindFirst.mockResolvedValue(makeVersion({ version: 4 }));
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 5 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await publishDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
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
    given(makeWorkflow({ draftDefinition: VALID_DEF, publishedVersionId: null }));
    txState.versionFindFirst.mockResolvedValue(null);
    txState.versionCreate.mockResolvedValue(makeVersion({ version: 1 }));
    txState.workflowUpdate.mockResolvedValue(makeWorkflow());

    await publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.publish',
        changes: { publishedVersion: { from: null, to: 1 } },
      })
    );
  });

  it('does not partially commit if the transaction throws', async () => {
    given(makeWorkflow({ draftDefinition: VALID_DEF }));
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID })
    ).rejects.toThrow('connection lost');
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

// ─── rollback ───────────────────────────────────────────────────────────────

describe('rollback', () => {
  it('throws NotFoundError when workflow does not exist', async () => {
    given(null);
    await expect(
      rollback({ workflowId: WORKFLOW_ID, targetVersionId: VERSION_ID_V1, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when target version does not exist', async () => {
    given(makeWorkflow());
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(null);
    await expect(
      rollback({ workflowId: WORKFLOW_ID, targetVersionId: VERSION_ID_V1, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when target version belongs to a different workflow', async () => {
    given(makeWorkflow());
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ workflowId: OTHER_WORKFLOW_ID }) as never
    );
    await expect(
      rollback({ workflowId: WORKFLOW_ID, targetVersionId: VERSION_ID_V1, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates a NEW version (does not mutate the target row) and pins to it', async () => {
    given(makeWorkflow({ publishedVersionId: VERSION_ID_V2 }));
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
    given(makeWorkflow({ publishedVersionId: VERSION_ID_V1 }));
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
    given(makeWorkflow({ publishedVersionId: VERSION_ID_V2 }));
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

// ─── erased recipients (t-805) ─────────────────────────────────────────────

describe('a definition that names an erased person (t-805)', () => {
  const ERASED_ID = 'cmjbv4i3x00003wsloputgone';
  const ERASED_ADDRESS = 'gone@example.com';
  const ERASED_DEF: WorkflowDefinition = {
    steps: [
      {
        id: 'approve',
        name: 'Approve',
        type: 'human_approval',
        config: { prompt: 'OK?', approverUserIds: [ERASED_ID] },
        nextSteps: [],
      },
    ],
    entryStepId: 'approve',
    errorStrategy: 'fail',
  };
  const ADDRESSED_DEF: WorkflowDefinition = {
    steps: [
      {
        id: 'notify',
        name: 'Notify',
        type: 'send_notification',
        config: { channel: 'email', to: ' Gone@Example.com ', subject: 'Hi', bodyTemplate: 'x' },
        nextSteps: [],
      },
    ],
    entryStepId: 'notify',
    errorStrategy: 'fail',
  };
  const addressReceipt = {
    subjectUserId: 'cmjbv4i3x00003wsloputaddr',
    subjectEmailHash: createHash('sha256').update(ERASED_ADDRESS).digest('hex'),
    metadata: { addressVerified: true },
  };

  beforeEach(() => {
    // A receipt exists for the approver the definition names
    txState.receiptFindMany.mockResolvedValue([
      { subjectUserId: ERASED_ID, subjectEmailHash: null, metadata: null },
    ]);
  });

  it('saveDraft strips an erased approver id and saves the rest (review round 2)', async () => {
    given(makeWorkflow());

    await saveDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
      definition: ERASED_DEF,
      userId: ADMIN_ID,
    });

    expect(txState.workflowUpdate).toHaveBeenCalledTimes(1);
    const [{ data }] = txState.workflowUpdate.mock.calls[0] as [
      { data: { draftDefinition: WorkflowDefinition } },
    ];
    expect(data.draftDefinition.steps[0].config).toEqual({ prompt: 'OK?', approverUserIds: [] });
    // The lock for the approver was taken before the check
    expect(txState.executeRaw).toHaveBeenCalled();
  });

  it('saveDraft writes an erased address from a builder loaded now: a deliberate re-add (§122 t-900)', async () => {
    given(makeWorkflow());
    txState.receiptFindMany.mockResolvedValue([addressReceipt]);

    await saveDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
      definition: ADDRESSED_DEF,
      userId: ADMIN_ID,
    });

    const [{ data }] = txState.workflowUpdate.mock.calls[0] as [
      { data: { draftDefinition: WorkflowDefinition } },
    ];
    expect(data.draftDefinition).toEqual(ADDRESSED_DEF);
    // Only approver ids are looked up: an address receipt cannot refuse it.
    expect(txState.receiptFindMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ subjectEmailHash: expect.anything() }),
          ]),
        }),
      })
    );
  });

  it('publishDraft publishes without an erased approver id', async () => {
    given(makeWorkflow({ draftDefinition: ERASED_DEF }));
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(makeVersion() as never);
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 5 }));

    await publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID });

    const [{ data }] = txState.versionCreate.mock.calls[0] as [
      { data: { snapshot: WorkflowDefinition } },
    ];
    expect(data.snapshot.steps[0].config).toEqual({ prompt: 'OK?', approverUserIds: [] });
  });

  it('publishDraft publishes an erased address the current draft holds (§122 t-900)', async () => {
    given(makeWorkflow({ draftDefinition: ADDRESSED_DEF }));
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(makeVersion() as never);
    txState.receiptFindMany.mockResolvedValue([addressReceipt]);
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 2 }));

    await publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID });

    const [{ data }] = txState.versionCreate.mock.calls[0] as [
      { data: { snapshot: WorkflowDefinition } },
    ];
    expect(data.snapshot).toEqual(ADDRESSED_DEF);
  });

  it('rollback copies the version without the erased approver, and says so in the audit row', async () => {
    // A snapshot cannot be edited, so a refusal would block this rollback for
    // good (t-805 review): the copy leaves the person out instead.
    given(makeWorkflow());
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ snapshot: ERASED_DEF }) as never
    );
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 5 }));

    await rollback({ workflowId: WORKFLOW_ID, targetVersionId: VERSION_ID_V1, userId: ADMIN_ID });

    expect(txState.versionCreate).toHaveBeenCalledTimes(1);
    const [{ data }] = txState.versionCreate.mock.calls[0] as [
      { data: { snapshot: WorkflowDefinition } },
    ];
    expect(data.snapshot.steps[0].config).toEqual({ prompt: 'OK?', approverUserIds: [] });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.rollback',
        metadata: expect.objectContaining({ erasedRecipientsRemoved: true }),
      })
    );
  });

  it("createInitialVersion writes a create's erased address, under erasure's lock on the passed transaction", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      dataErasureReceipt: { findMany: vi.fn().mockResolvedValue([addressReceipt]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      aiWorkflow: { update: vi.fn() },
      aiWorkflowVersion: { create: vi.fn().mockResolvedValue(makeVersion()) },
    };

    await createInitialVersion({
      tx: tx as never,
      workflowId: WORKFLOW_ID,
      definition: ADDRESSED_DEF,
      userId: ADMIN_ID,
    });

    // The lock for the address, on the caller's transaction: a new version
    // row an erasure in flight would not otherwise see.
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.aiWorkflowVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ snapshot: ADDRESSED_DEF }) })
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── stale writes (§122 t-900) ─────────────────────────────────────────────

describe('a write from a builder loaded before the workflow moved on (§122 t-900)', () => {
  const STALE = ['"loaded-before"'];

  it('saveDraft is refused with 412, writes nothing and logs nothing', async () => {
    given(makeWorkflow());

    await expect(
      saveDraft({ workflowId: WORKFLOW_ID, loadedAt: STALE, definition: ALT_DEF, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(StaleRecordError);

    expect(txState.workflowUpdate).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it("saveDraft takes erasure's locks first, then the row lock, then reads the version", async () => {
    const def: WorkflowDefinition = {
      ...VALID_DEF,
      steps: [
        {
          id: 'n',
          name: 'N',
          type: 'send_notification',
          config: { channel: 'email', to: 'someone@example.com', subject: 's', bodyTemplate: 'b' },
          nextSteps: [],
        },
      ],
      entryStepId: 'n',
    };
    given(makeWorkflow());

    await saveDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
      definition: def,
      userId: ADMIN_ID,
    });

    // Erasure takes the subject locks, then the rows: the same order cannot deadlock.
    const subjectLock = txState.executeRaw.mock.invocationCallOrder[0];
    const rowLock = txState.queryRaw.mock.invocationCallOrder[0];
    const read = txState.workflowFindUniqueOrThrow.mock.invocationCallOrder[0];
    expect(subjectLock).toBeLessThan(rowLock);
    expect(rowLock).toBeLessThan(read);
    expect(read).toBeLessThan(txState.workflowUpdate.mock.invocationCallOrder[0]);
  });

  it('saveDraft is refused when only the published version moved on (a publish or rollback since)', async () => {
    const loaded = makeWorkflow();
    given(loaded);
    const loadedAt = current();
    stored = makeWorkflow({ publishedVersionId: VERSION_ID_V2 });

    await expect(
      saveDraft({ workflowId: WORKFLOW_ID, loadedAt, definition: ALT_DEF, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(StaleRecordError);
  });

  it('publishDraft is refused before validation, and creates no version', async () => {
    given(makeWorkflow({ draftDefinition: VALID_DEF }));

    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt: STALE, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(StaleRecordError);

    expect(semanticValidateWorkflow).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('publishDraft is refused when the draft changed between its read and the lock (an erasure)', async () => {
    given(makeWorkflow({ draftDefinition: VALID_DEF }));
    const loadedAt = current();
    // Under the lock the stored draft is no longer the one validated.
    txState.workflowFindUniqueOrThrow.mockResolvedValue(makeWorkflow({ draftDefinition: ALT_DEF }));

    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(StaleRecordError);

    expect(txState.versionCreate).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('discardDraft is refused with 412 and clears nothing', async () => {
    given(makeWorkflow({ draftDefinition: ALT_DEF }));

    await expect(
      discardDraft({ workflowId: WORKFLOW_ID, loadedAt: STALE, userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(StaleRecordError);

    expect(txState.workflowUpdate).not.toHaveBeenCalled();
  });

  it('accepts a save whose If-Match lists the current version among others', async () => {
    given(makeWorkflow());

    await saveDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: [...STALE, ...current()],
      definition: ALT_DEF,
      userId: ADMIN_ID,
    });

    expect(txState.workflowUpdate).toHaveBeenCalledOnce();
  });
});

describe("rollback reads its target again under erasure's locks (§122 t-900)", () => {
  it('is refused with 412 when an erasure changed the target since the first read', async () => {
    given(makeWorkflow());
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ snapshot: VALID_DEF }) as never
    );
    txState.versionFindUnique.mockResolvedValue({ snapshot: ALT_DEF });

    const error = await rollback({
      workflowId: WORKFLOW_ID,
      targetVersionId: VERSION_ID_V1,
      userId: ADMIN_ID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StaleRecordError);
    expect((error as StaleRecordError).message).toMatch(/Try the rollback again/);
    expect(txState.versionCreate).not.toHaveBeenCalled();
    expect(txState.workflowUpdate).not.toHaveBeenCalled();
  });

  it('takes the locks before the second read, and needs no If-Match', async () => {
    given(makeWorkflow());
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(
      makeVersion({ snapshot: ERASABLE }) as never
    );
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 2 }));

    await rollback({ workflowId: WORKFLOW_ID, targetVersionId: VERSION_ID_V1, userId: ADMIN_ID });

    expect(txState.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      txState.versionFindUnique.mock.invocationCallOrder[0]
    );
    expect(txState.versionFindUnique).toHaveBeenCalledWith({
      where: { id: VERSION_ID_V1 },
      select: { snapshot: true },
    });
    expect(txState.versionCreate).toHaveBeenCalledOnce();
  });
});

const ERASABLE: WorkflowDefinition = {
  steps: [
    {
      id: 'n',
      name: 'N',
      type: 'send_notification',
      config: { channel: 'email', to: 'someone@example.com', subject: 's', bodyTemplate: 'b' },
      nextSteps: [],
    },
  ],
  entryStepId: 'n',
  errorStrategy: 'fail',
};

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

describe('org provider approval on publish and rollback (§120 t-743)', () => {
  /** The `held` loader publish or rollback handed the validator. */
  function heldLoader(): () => Promise<unknown> {
    const options = vi.mocked(semanticValidateWorkflow).mock.calls[0]?.[1] as {
      approval: { held: () => Promise<unknown> };
    };
    return options.approval.held;
  }

  it('hands the validator the published version as held, loaded only when asked', async () => {
    given(makeWorkflow({ draftDefinition: ALT_DEF, publishedVersionId: VERSION_ID_V1 }));
    vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue({
      snapshot: VALID_DEF,
    } as never);

    await publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID }).catch(
      () => undefined
    );

    expect(semanticValidateWorkflow).toHaveBeenCalledWith(ALT_DEF, {
      approval: { held: expect.any(Function) },
    });
    // Lazy: the snapshot is not read until the validator needs to excuse something.
    const snapshotRead = { where: { id: VERSION_ID_V1 }, select: { snapshot: true } };
    expect(prisma.aiWorkflowVersion.findUnique).not.toHaveBeenCalledWith(snapshotRead);
    await expect(heldLoader()()).resolves.toEqual(VALID_DEF);
    expect(prisma.aiWorkflowVersion.findUnique).toHaveBeenCalledWith(snapshotRead);
  });

  it('holds nothing when the workflow has no published version', async () => {
    given(makeWorkflow({ draftDefinition: ALT_DEF, publishedVersionId: null }));

    await publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID }).catch(
      () => undefined
    );

    await expect(heldLoader()()).resolves.toBeNull();
    expect(prisma.aiWorkflowVersion.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ select: { snapshot: true } })
    );
  });

  it('refuses the publish when the approval check refuses a step', async () => {
    given(makeWorkflow({ draftDefinition: ALT_DEF }));
    vi.mocked(semanticValidateWorkflow).mockResolvedValueOnce({
      ok: false,
      errors: [{ code: 'PROVIDER_NOT_APPROVED', message: 'not approved', stepId: 's1' }],
    });

    await expect(
      publishDraft({ workflowId: WORKFLOW_ID, loadedAt: current(), userId: ADMIN_ID })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rolls back with the current published version as held', async () => {
    given(makeWorkflow({ publishedVersionId: VERSION_ID_V2 }));
    vi.mocked(prisma.aiWorkflowVersion.findUnique)
      // The rollback target.
      .mockResolvedValueOnce(makeVersion({ snapshot: ALT_DEF }) as never)
      // The published version it replaces, when the loader is called.
      .mockResolvedValueOnce({ snapshot: VALID_DEF } as never);

    await rollback({
      workflowId: WORKFLOW_ID,
      targetVersionId: VERSION_ID_V1,
      userId: ADMIN_ID,
    }).catch(() => undefined);

    await expect(heldLoader()()).resolves.toEqual(VALID_DEF);
    expect(prisma.aiWorkflowVersion.findUnique).toHaveBeenLastCalledWith({
      where: { id: VERSION_ID_V2 },
      select: { snapshot: true },
    });
  });
});

describe('createInitialVersion with a copy of a stored workflow (§122 t-900)', () => {
  const SOURCE_ID = 'cmjbv4i3x00003wslotemplate';
  const SOURCE = {
    draftDefinition: null,
    publishedVersionId: 'v1',
    publishedVersion: { snapshot: VALID_DEF },
  };
  function copyTx(stored: unknown) {
    return {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      dataErasureReceipt: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      aiWorkflow: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue(stored) },
      aiWorkflowVersion: { create: vi.fn().mockResolvedValue(makeVersion()) },
    };
  }
  const copyOf = (definitionVersion: string) => ({ workflowId: SOURCE_ID, definitionVersion });

  it('writes the copy when its source is still at the version it was copied at', async () => {
    const tx = copyTx(SOURCE);

    await createInitialVersion({
      tx: tx as never,
      workflowId: WORKFLOW_ID,
      definition: ERASABLE,
      copiedFrom: copyOf(workflowDefinitionVersion(SOURCE as never)),
      userId: ADMIN_ID,
    });

    expect(tx.aiWorkflowVersion.create).toHaveBeenCalledOnce();
    // Erasure's locks for the copy's addresses first, then the source's row.
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.aiWorkflow.findUnique.mock.invocationCallOrder[0]
    );
    expect(tx.aiWorkflow.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SOURCE_ID } })
    );
  });

  it('refuses with 412, creating nothing, when the source moved on (an erasure scrubbed it)', async () => {
    const scrubbed = { ...SOURCE, publishedVersion: { snapshot: ALT_DEF } };
    const tx = copyTx(scrubbed);

    const error = await createInitialVersion({
      tx: tx as never,
      workflowId: WORKFLOW_ID,
      definition: ERASABLE,
      copiedFrom: copyOf(workflowDefinitionVersion(SOURCE as never)),
      userId: ADMIN_ID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StaleRecordError);
    expect((error as StaleRecordError).message).toMatch(/copied from changed/);
    expect(tx.aiWorkflowVersion.create).not.toHaveBeenCalled();
    expect(tx.aiWorkflow.update).not.toHaveBeenCalled();
  });

  it('refuses a copy whose source this org cannot see, or that is gone', async () => {
    const tx = copyTx(null);

    await expect(
      createInitialVersion({
        tx: tx as never,
        workflowId: WORKFLOW_ID,
        definition: ERASABLE,
        copiedFrom: copyOf('"any"'),
        userId: ADMIN_ID,
      })
    ).rejects.toBeInstanceOf(StaleRecordError);
    expect(tx.aiWorkflowVersion.create).not.toHaveBeenCalled();
  });

  it('checks no source for a create typed from scratch', async () => {
    const tx = copyTx(SOURCE);

    await createInitialVersion({
      tx: tx as never,
      workflowId: WORKFLOW_ID,
      definition: ERASABLE,
      userId: ADMIN_ID,
    });

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.aiWorkflow.findUnique).not.toHaveBeenCalled();
  });
});

describe('the version each write leaves, and fields written alongside a draft (§122 t-900)', () => {
  it('saveDraft writes the other fields in the same update, and returns the version read after it', async () => {
    given(makeWorkflow());
    const after = makeWorkflow({ draftDefinition: ALT_DEF });
    txState.workflowFindUniqueOrThrow
      .mockResolvedValueOnce(makeWorkflow()) // the check
      .mockResolvedValueOnce(after); // the version left
    txState.workflowUpdate.mockResolvedValue(after);

    const result = await saveDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
      definition: ALT_DEF,
      alongside: { name: 'Renamed' },
      userId: ADMIN_ID,
    });

    expect(txState.workflowUpdate.mock.calls[0]?.[0]).toMatchObject({
      data: { name: 'Renamed', draftDefinition: ALT_DEF },
    });
    expect(result.definitionVersion).toBe(versionOf(after));
  });

  it('discardDraft writes the other fields with the clear, and returns the version it left', async () => {
    given(makeWorkflow({ draftDefinition: ALT_DEF }));
    const after = makeWorkflow();
    txState.workflowFindUniqueOrThrow
      .mockResolvedValueOnce(makeWorkflow({ draftDefinition: ALT_DEF }))
      .mockResolvedValueOnce(after);
    txState.workflowUpdate.mockResolvedValue(after);

    const result = await discardDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
      alongside: { name: 'Renamed' },
      userId: ADMIN_ID,
    });

    expect(txState.workflowUpdate.mock.calls[0]?.[0]).toMatchObject({
      data: { name: 'Renamed', draftDefinition: Prisma.DbNull },
    });
    expect(result.definitionVersion).toBe(versionOf(after));
  });

  it('publishDraft returns the version it left, read after its writes', async () => {
    given(makeWorkflow({ draftDefinition: VALID_DEF }));
    const after = makeWorkflow({ publishedVersionId: VERSION_ID_NEW });
    txState.workflowFindUniqueOrThrow
      .mockResolvedValueOnce(makeWorkflow({ draftDefinition: VALID_DEF }))
      .mockResolvedValueOnce(after);
    txState.versionCreate.mockResolvedValue(makeVersion({ id: VERSION_ID_NEW, version: 2 }));
    txState.workflowUpdate.mockResolvedValue(after);

    const result = await publishDraft({
      workflowId: WORKFLOW_ID,
      loadedAt: current(),
      userId: ADMIN_ID,
    });

    expect(result.definitionVersion).toBe(versionOf(after));
    expect(txState.workflowFindUniqueOrThrow.mock.invocationCallOrder[1]).toBeGreaterThan(
      txState.workflowUpdate.mock.invocationCallOrder[0]
    );
  });
});

describe('a copy of the published snapshot ignores a draft saved on its source (§122 t-900 review)', () => {
  const SOURCE_ID = 'cmjbv4i3x00003wslotemplate';
  const PUBLISHED = { publishedVersionId: 'v1', publishedVersion: { snapshot: VALID_DEF } };
  function copyTx(stored: unknown) {
    return {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      dataErasureReceipt: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      aiWorkflow: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue(stored) },
      aiWorkflowVersion: { create: vi.fn().mockResolvedValue(makeVersion()) },
    };
  }
  const create = (tx: unknown, definitionVersion: string) =>
    createInitialVersion({
      tx: tx as never,
      workflowId: WORKFLOW_ID,
      definition: ERASABLE,
      copiedFrom: { workflowId: SOURCE_ID, definitionVersion },
      userId: ADMIN_ID,
    });

  it('accepts a template copy after someone saved a draft on the template', async () => {
    const copiedAt = publishedSnapshotVersion(PUBLISHED as never);
    const tx = copyTx({ ...PUBLISHED, draftDefinition: ALT_DEF });

    await create(tx, copiedAt);

    expect(tx.aiWorkflowVersion.create).toHaveBeenCalledOnce();
  });

  it('refuses a template copy once the published snapshot moved on', async () => {
    const copiedAt = publishedSnapshotVersion(PUBLISHED as never);
    const tx = copyTx({
      draftDefinition: null,
      publishedVersionId: 'v1',
      publishedVersion: { snapshot: ALT_DEF },
    });

    await expect(create(tx, copiedAt)).rejects.toBeInstanceOf(StaleRecordError);
  });

  it('still refuses a Duplicate copy once the draft it copied moved on', async () => {
    const copiedAt = workflowDefinitionVersion({
      ...PUBLISHED,
      draftDefinition: VALID_DEF,
    } as never);
    const tx = copyTx({ ...PUBLISHED, draftDefinition: ALT_DEF });

    await expect(create(tx, copiedAt)).rejects.toBeInstanceOf(StaleRecordError);
  });
});

it('audits a draft save under the name it wrote, when the save renames the workflow', async () => {
  given(makeWorkflow());
  txState.workflowUpdate.mockResolvedValue(makeWorkflow({ name: 'Renamed' }));

  await saveDraft({
    workflowId: WORKFLOW_ID,
    loadedAt: current(),
    definition: ALT_DEF,
    alongside: { name: 'Renamed' },
    userId: ADMIN_ID,
  });

  expect(logAdminAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'workflow.draft.save', entityName: 'Renamed' })
  );
});
