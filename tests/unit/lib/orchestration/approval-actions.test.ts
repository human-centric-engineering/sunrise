/**
 * Unit Test: Shared approval/rejection actions
 *
 * @see lib/orchestration/approval-actions.ts
 *
 * Coverage targets:
 * - executeApproval happy path: status transition, trace update, audit log
 * - executeRejection happy path: status cancelled, errorMessage prefixed
 * - Error cases: not found, invalid status, corrupted trace, concurrent race
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { executeApproval, executeRejection } from '@/lib/orchestration/approval-actions';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: 'wf-1',
    userId: 'user-1',
    status: 'paused_for_approval',
    currentStep: 'approval-step',
    executionTrace: [
      {
        stepId: 'approval-step',
        stepType: 'human_approval',
        label: 'Review',
        status: 'awaiting_approval',
        output: { prompt: 'Approve?' },
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:00:00Z',
        durationMs: 0,
      },
    ],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('executeApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  it('transitions execution to PENDING and updates trace', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    const result = await executeApproval(EXECUTION_ID, {
      notes: 'Looks good',
      actorLabel: 'admin:user-1',
    });

    expect(result.success).toBe(true);
    expect(result.executionId).toBe(EXECUTION_ID);
    expect(result.resumeStepId).toBe('approval-step');
    expect(result.workflowId).toBe('wf-1');

    const updateCall = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls[0][0];
    expect(updateCall.where).toEqual({
      id: EXECUTION_ID,
      status: 'paused_for_approval',
    });
    expect(updateCall.data.status).toBe('pending');

    // Trace entry should be updated to completed
    const trace = updateCall.data.executionTrace as Array<Record<string, unknown>>;
    expect(trace[0].status).toBe('completed');
    expect((trace[0].output as Record<string, unknown>).notes).toBe('Looks good');
  });

  it('includes actor label in trace output', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    await executeApproval(EXECUTION_ID, {
      actorLabel: 'token:external',
    });

    const updateCall = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls[0][0];
    const trace = updateCall.data.executionTrace as Array<Record<string, unknown>>;
    expect((trace[0].output as Record<string, unknown>).actor).toBe('token:external');
  });

  it('logs approval with actor', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    await executeApproval(EXECUTION_ID, { actorLabel: 'admin:user-1' });

    expect(logger.info).toHaveBeenCalledWith(
      'execution approved',
      expect.objectContaining({ actor: 'admin:user-1' })
    );
  });

  it('throws NOT_FOUND when execution does not exist', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

    await expect(executeApproval(EXECUTION_ID, { actorLabel: 'test' })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
  });

  it('throws INVALID_STATUS when not paused_for_approval', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'running' }) as never
    );

    await expect(executeApproval(EXECUTION_ID, { actorLabel: 'test' })).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_STATUS' })
    );
  });

  it('throws TRACE_CORRUPTED when trace has no awaiting_approval entry', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ executionTrace: [] }) as never
    );

    await expect(executeApproval(EXECUTION_ID, { actorLabel: 'test' })).rejects.toThrow(
      expect.objectContaining({ code: 'TRACE_CORRUPTED' })
    );
  });

  it('throws TRACE_CORRUPTED when trace entries exist but none awaiting', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({
        executionTrace: [
          {
            stepId: 'step-1',
            stepType: 'llm_call',
            label: 'Generate',
            status: 'completed',
            output: {},
            tokensUsed: 100,
            costUsd: 0.01,
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:00:01Z',
            durationMs: 1000,
          },
        ],
      }) as never
    );

    await expect(executeApproval(EXECUTION_ID, { actorLabel: 'test' })).rejects.toThrow(
      expect.objectContaining({ code: 'TRACE_CORRUPTED' })
    );
  });

  it('throws CONCURRENT when updateMany returns count 0', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 0 } as never);

    await expect(executeApproval(EXECUTION_ID, { actorLabel: 'test' })).rejects.toThrow(
      expect.objectContaining({ code: 'CONCURRENT' })
    );
  });
});

describe('executeRejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  it('transitions execution to CANCELLED and updates trace entry to rejected', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    const result = await executeRejection(EXECUTION_ID, {
      reason: 'Not appropriate',
      actorLabel: 'admin:user-1',
    });

    expect(result.success).toBe(true);
    expect(result.executionId).toBe(EXECUTION_ID);

    const updateCall = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls[0][0];
    expect(updateCall.data.status).toBe('cancelled');
    expect(updateCall.data.errorMessage).toBe('Rejected: Not appropriate');
    expect(updateCall.data.completedAt).toBeInstanceOf(Date);

    // Trace entry should be updated to rejected
    const trace = updateCall.data.executionTrace as Array<Record<string, unknown>>;
    expect(trace[0].status).toBe('rejected');
    const output = trace[0].output as Record<string, unknown>;
    expect(output.rejected).toBe(true);
    expect(output.reason).toBe('Not appropriate');
    expect(output.actor).toBe('admin:user-1');
    expect(trace[0].completedAt).toBeDefined();
  });

  it('logs rejection with actor and reason', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    await executeRejection(EXECUTION_ID, {
      reason: 'Cost too high',
      actorLabel: 'token:external',
    });

    expect(logger.info).toHaveBeenCalledWith(
      'execution rejected',
      expect.objectContaining({
        actor: 'token:external',
        reason: 'Cost too high',
      })
    );
  });

  it('throws NOT_FOUND when execution does not exist', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

    await expect(
      executeRejection(EXECUTION_ID, { reason: 'r', actorLabel: 'test' })
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('throws INVALID_STATUS when not paused_for_approval', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'completed' }) as never
    );

    await expect(
      executeRejection(EXECUTION_ID, { reason: 'r', actorLabel: 'test' })
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_STATUS' }));
  });

  it('throws TRACE_CORRUPTED when trace has no awaiting_approval entry', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ executionTrace: [] }) as never
    );

    await expect(
      executeRejection(EXECUTION_ID, { reason: 'r', actorLabel: 'test' })
    ).rejects.toThrow(expect.objectContaining({ code: 'TRACE_CORRUPTED' }));
  });

  it('throws TRACE_CORRUPTED when trace is malformed', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ executionTrace: 'not-an-array' }) as never
    );

    await expect(
      executeRejection(EXECUTION_ID, { reason: 'r', actorLabel: 'test' })
    ).rejects.toThrow(expect.objectContaining({ code: 'TRACE_CORRUPTED' }));
  });

  it('throws CONCURRENT when updateMany returns count 0', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 0 } as never);

    await expect(
      executeRejection(EXECUTION_ID, { reason: 'r', actorLabel: 'test' })
    ).rejects.toThrow(expect.objectContaining({ code: 'CONCURRENT' }));
  });
});
