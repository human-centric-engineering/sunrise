/**
 * Tests for `RunWorkflowCapability`.
 *
 * Mocks prisma + the OrchestrationEngine + approval-tokens. The engine
 * mock is constructed per-test with a controllable async generator so
 * we can drive the capability through completed / paused / failed
 * paths without reaching into engine internals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgentCapability: { findFirst: vi.fn() },
    aiWorkflow: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockEngineExecute =
  vi.fn<(arg: unknown, input: unknown, opts: unknown) => AsyncIterable<ExecutionEvent>>();

vi.mock('@/lib/orchestration/engine/orchestration-engine', () => ({
  OrchestrationEngine: class MockOrchestrationEngine {
    execute(...args: unknown[]): AsyncIterable<ExecutionEvent> {
      return mockEngineExecute(args[0], args[1], args[2]);
    }
  },
}));

vi.mock('@/lib/orchestration/approval-tokens', () => ({
  generateApprovalToken: vi.fn(
    (executionId: string, action: 'approve' | 'reject', expiresInMinutes?: number) => ({
      token: `mock-${action}-${executionId}-${expiresInMinutes ?? 'default'}`,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    })
  ),
}));

const { prisma } = await import('@/lib/db/client');
const { RunWorkflowCapability } =
  await import('@/lib/orchestration/capabilities/built-in/run-workflow');

const findBinding = prisma.aiAgentCapability.findFirst as ReturnType<typeof vi.fn>;
const findWorkflow = prisma.aiWorkflow.findFirst as ReturnType<typeof vi.fn>;

const context = { userId: 'user-1', agentId: 'agent-1' };

function bindCustomConfig(config: unknown): void {
  findBinding.mockResolvedValue({ customConfig: config });
}

function noBinding(): void {
  findBinding.mockResolvedValue(null);
}

function existingWorkflow(
  slug: string,
  definition?: Partial<WorkflowDefinition>
): { id: string; slug: string; definition: WorkflowDefinition } {
  const fullDefinition: WorkflowDefinition = {
    entryStepId: 'step-1',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'step-1',
        name: 'First step',
        type: 'human_approval',
        config: { prompt: 'Confirm this action' },
        nextSteps: [],
      },
    ],
    ...definition,
  };
  // The capability now resolves the definition from the published version
  // relation, not from a top-level workflowDefinition column.
  const row = {
    id: `wf-${slug}`,
    slug,
    publishedVersion: { id: `wfv-${slug}`, snapshot: fullDefinition },
  };
  findWorkflow.mockResolvedValue(row);
  return { id: row.id, slug, definition: fullDefinition };
}

function workflowEvents(events: ExecutionEvent[]): void {
  mockEngineExecute.mockImplementation(async function* () {
    for (const e of events) yield e;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RunWorkflowCapability', () => {
  describe('args validation', () => {
    it('rejects missing workflowSlug', () => {
      const cap = new RunWorkflowCapability();
      expect(() => cap.validate({})).toThrow();
    });

    it('rejects empty workflowSlug', () => {
      const cap = new RunWorkflowCapability();
      expect(() => cap.validate({ workflowSlug: '' })).toThrow();
    });

    it('accepts a valid args object with optional input', () => {
      const cap = new RunWorkflowCapability();
      const args = cap.validate({ workflowSlug: 'refund-flow', input: { orderId: 'o1' } });
      expect(args.workflowSlug).toBe('refund-flow');
      expect(args.input).toEqual({ orderId: 'o1' });
    });
  });

  describe('customConfig handling', () => {
    it('fails closed (invalid_binding) when no customConfig is set', async () => {
      noBinding();
      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'x' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });

    it('fails closed (invalid_binding) when customConfig is malformed', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: 'not-an-array' });
      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'x' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });

    it('rejects (workflow_not_allowed) when slug is not in allowedWorkflowSlugs', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'something-else' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('workflow_not_allowed');
    });
  });

  describe('workflow lookup', () => {
    beforeEach(() => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
    });

    it('returns workflow_not_found when DB has no row', async () => {
      findWorkflow.mockResolvedValue(null);
      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('workflow_not_found');
    });

    it('returns workflow_malformed when the definition fails Zod', async () => {
      findWorkflow.mockResolvedValue({
        id: 'wf-1',
        slug: 'refund-flow',
        publishedVersion: {
          id: 'wfv-1',
          snapshot: { entryStepId: 'x' /* missing steps */ },
        },
      });
      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('workflow_malformed');
    });
  });

  describe('engine drain — intermediate events ignored', () => {
    it('ignores step_started/step_completed/budget_warning between workflow_started and the terminal event', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
      existingWorkflow('refund-flow');
      workflowEvents([
        { type: 'workflow_started', executionId: 'exec-noise', workflowId: 'wf-1' },
        { type: 'step_started', stepId: 'step-1', stepType: 'human_approval', label: 'Approve' },
        { type: 'budget_warning', usedUsd: 0.4, limitUsd: 0.5 },
        {
          type: 'approval_required',
          stepId: 'step-1',
          payload: { prompt: 'Approve?', timeoutMinutes: 60 },
        },
      ]);

      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);
      expect(result.success).toBe(true);
      expect((result.data as { status: string }).status).toBe('pending_approval');
    });
  });

  describe('engine drain — completed', () => {
    it('returns status:completed with output and totals', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
      existingWorkflow('refund-flow');
      workflowEvents([
        { type: 'workflow_started', executionId: 'exec-1', workflowId: 'wf-1' },
        {
          type: 'workflow_completed',
          output: { refundId: 'r-99' },
          totalCostUsd: 0.0123,
          totalTokensUsed: 456,
        },
      ]);

      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);

      expect(result.success).toBe(true);
      expect(result.skipFollowup).toBeUndefined();
      expect(result.data).toEqual({
        status: 'completed',
        executionId: 'exec-1',
        output: { refundId: 'r-99' },
        totalCostUsd: 0.0123,
        totalTokensUsed: 456,
      });
    });
  });

  describe('engine drain — paused (approval required)', () => {
    it('returns status:pending_approval with prompt + tokens, sets skipFollowup', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
      existingWorkflow('refund-flow');
      workflowEvents([
        { type: 'workflow_started', executionId: 'exec-2', workflowId: 'wf-1' },
        {
          type: 'approval_required',
          stepId: 'step-1',
          payload: { prompt: 'Refund £42.50?', timeoutMinutes: 30 },
        },
      ]);

      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);

      expect(result.success).toBe(true);
      expect(result.skipFollowup).toBe(true);
      expect(result.data).toMatchObject({
        status: 'pending_approval',
        executionId: 'exec-2',
        stepId: 'step-1',
        prompt: 'Refund £42.50?',
        approveToken: 'mock-approve-exec-2-30',
        rejectToken: 'mock-reject-exec-2-30',
      });
    });

    it('falls back to step.config.prompt when payload prompt is missing', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
      existingWorkflow('refund-flow', {
        steps: [
          {
            id: 'step-1',
            name: 'First',
            type: 'human_approval',
            config: { prompt: 'Definition-level prompt' },
            nextSteps: [],
          },
        ],
      });
      workflowEvents([
        { type: 'workflow_started', executionId: 'exec-3', workflowId: 'wf-1' },
        {
          type: 'approval_required',
          stepId: 'step-1',
          payload: {}, // no prompt
        },
      ]);

      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);

      expect(result.success).toBe(true);
      expect((result.data as { prompt: string }).prompt).toBe('Definition-level prompt');
    });
  });

  describe('engine drain — failed', () => {
    it('returns capability error workflow_failed when the engine yields workflow_failed', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
      existingWorkflow('refund-flow');
      workflowEvents([
        { type: 'workflow_started', executionId: 'exec-4', workflowId: 'wf-1' },
        { type: 'workflow_failed', error: 'Provider down', failedStepId: 'step-1' },
      ]);

      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('workflow_failed');
      expect(result.error?.message).toContain('exec-4');
      expect(result.error?.message).toContain('step-1');
      expect(result.error?.message).toContain('Provider down');
    });
  });

  describe('engine error paths', () => {
    beforeEach(() => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
      existingWorkflow('refund-flow');
    });

    it('returns workflow_dispatch_failed when the engine throws mid-stream', async () => {
      mockEngineExecute.mockImplementation(async function* () {
        yield { type: 'workflow_started', executionId: 'exec-5', workflowId: 'wf-1' };
        throw new Error('boom');
      });

      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('workflow_dispatch_failed');
      expect(result.error?.message).toContain('boom');
    });

    it('returns workflow_no_terminal when the engine drains without a terminal event', async () => {
      mockEngineExecute.mockImplementation(async function* () {
        yield { type: 'workflow_started', executionId: 'exec-6', workflowId: 'wf-1' };
        // no completed / failed / approval_required
      });

      const cap = new RunWorkflowCapability();
      const result = await cap.execute({ workflowSlug: 'refund-flow' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('workflow_no_terminal');
    });
  });

  describe('budget forwarding', () => {
    it('forwards defaultBudgetUsd to the engine when set', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'], defaultBudgetUsd: 1.5 });
      existingWorkflow('refund-flow');
      workflowEvents([
        { type: 'workflow_started', executionId: 'exec-7', workflowId: 'wf-1' },
        { type: 'workflow_completed', output: null, totalCostUsd: 0, totalTokensUsed: 0 },
      ]);

      const cap = new RunWorkflowCapability();
      await cap.execute({ workflowSlug: 'refund-flow' }, context);

      const opts = mockEngineExecute.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(opts.budgetLimitUsd).toBe(1.5);
    });

    it('omits budgetLimitUsd when defaultBudgetUsd is not set', async () => {
      bindCustomConfig({ allowedWorkflowSlugs: ['refund-flow'] });
      existingWorkflow('refund-flow');
      workflowEvents([
        { type: 'workflow_started', executionId: 'exec-8', workflowId: 'wf-1' },
        { type: 'workflow_completed', output: null, totalCostUsd: 0, totalTokensUsed: 0 },
      ]);

      const cap = new RunWorkflowCapability();
      await cap.execute({ workflowSlug: 'refund-flow' }, context);

      const opts = mockEngineExecute.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(opts.budgetLimitUsd).toBeUndefined();
    });
  });
});
