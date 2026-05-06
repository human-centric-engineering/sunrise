/**
 * Integration test — OTEL span tree emitted by OrchestrationEngine.execute.
 *
 * Approach: stubbed executors (the simpler path). The engine wraps every
 * span site (workflow.execute, sequential workflow.step, parallel
 * workflow.step) in `withSpanGenerator` / `withSpan`, which activate the
 * span as the OTEL active context across yields. MockTracer's
 * `withActiveContext` mirrors this by pushing/popping its `_activeStack`,
 * so nested spans pick up the active span as their parent — tests assert on
 * the parent/child tree via `parentSpanId`.
 *
 * Bonus test 6 (production runLlmCall path) is omitted — the full LLM provider
 * mocking infrastructure would be required to avoid hitting real endpoints, and
 * the engine's `llm.call` child spans live inside the production LLM executor
 * which is not exercised here. The existing trace-capture.test.ts covers the
 * step-telemetry contract that ties llm.call instrumentation to the trace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
  },
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock approval-related helpers so PausedForApproval tests don't need crypto setup.
vi.mock('@/lib/orchestration/approval-tokens', () => ({
  buildApprovalUrls: vi.fn(() => ({
    approveUrl: 'https://app.example.com/approve',
    rejectUrl: 'https://app.example.com/reject',
    expiresAt: new Date(Date.now() + 3600_000),
  })),
}));

vi.mock('@/lib/orchestration/notifications/dispatcher', () => ({
  dispatchApprovalNotification: vi.fn(() => undefined),
}));

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { ExecutorError, PausedForApproval } from '@/lib/orchestration/engine/errors';
import { prisma } from '@/lib/db/client';
import { registerTracer } from '@/lib/orchestration/tracing';
import { resetTracer } from '@/lib/orchestration/tracing/registry';
import { MockTracer, findSpan } from '@/tests/helpers/mock-tracer';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = 'user_test';

// ---------------------------------------------------------------------------
// Shared tracer instance
// ---------------------------------------------------------------------------

const tracer = new MockTracer();

// ---------------------------------------------------------------------------
// Fixtures — a base execution row returned by prisma.aiWorkflowExecution.create
// ---------------------------------------------------------------------------

const BASE_EXECUTION_ROW = {
  id: 'exec_test',
  workflowId: 'wf_test',
  userId: USER_ID,
  status: 'running',
  inputData: {},
  executionTrace: [],
  totalTokensUsed: 0,
  totalCostUsd: 0,
  defaultErrorStrategy: 'fail',
  budgetLimitUsd: null,
  currentStep: null,
  startedAt: new Date(),
  completedAt: null,
  failureReason: null,
} as const;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryForTests();
  resetTracer();
  tracer.reset();
  registerTracer(tracer);

  vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
    id: 'exec_test',
    status: 'running',
  } as never);

  vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue(BASE_EXECUTION_ROW as never);

  vi.mocked(prisma.aiWorkflowExecution.update).mockResolvedValue({} as never);
});

afterEach(() => {
  resetTracer();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper — drain the engine's async iterator
// ---------------------------------------------------------------------------

async function collect(
  engine: OrchestrationEngine,
  workflow: { id: string; definition: WorkflowDefinition }
): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const ev of engine.execute(workflow, {}, { userId: USER_ID })) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

function makeSequentialWorkflow(): { id: string; definition: WorkflowDefinition } {
  return {
    id: 'wf_test',
    definition: {
      steps: [
        {
          id: 'step_a',
          name: 'LLM step',
          type: 'llm_call',
          config: { prompt: 'hello' },
          nextSteps: [{ targetStepId: 'step_b' }],
        },
        {
          id: 'step_b',
          name: 'Tool step',
          type: 'tool_call',
          config: { capabilitySlug: 'lookup' },
          nextSteps: [{ targetStepId: 'step_c' }],
        },
        {
          id: 'step_c',
          name: 'Second LLM step',
          type: 'llm_call',
          config: { prompt: 'world' },
          nextSteps: [],
        },
      ],
      entryStepId: 'step_a',
      errorStrategy: 'fail',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OTEL engine span tree — integration', () => {
  // -----------------------------------------------------------------------
  // Test 1: Multi-step workflow span tree
  // -----------------------------------------------------------------------

  it('multi-step sequential workflow emits one workflow.execute and one workflow.step per step', async () => {
    // Arrange: register stub executors that return simple results
    registerStepType('llm_call', async () => ({
      output: { text: 'ok' },
      tokensUsed: 10,
      costUsd: 0.001,
    }));
    registerStepType('tool_call', async () => ({
      output: { result: 'found' },
      tokensUsed: 0,
      costUsd: 0,
    }));

    const workflow = makeSequentialWorkflow();

    // Act
    await collect(new OrchestrationEngine(), workflow);

    // Assert: workflow.execute span was emitted
    const execSpan = findSpan(tracer.spans, 'workflow.execute');
    expect(execSpan.status?.code).toBe('ok');

    // Assert: all three workflow.step spans were emitted
    const stepSpans = tracer.spans.filter((s) => s.name === 'workflow.step');
    expect(stepSpans).toHaveLength(3);

    // Assert: workflow.execute carries identity attributes
    expect(execSpan.attributes['sunrise.execution_id']).toBe('exec_test');
    expect(execSpan.attributes['sunrise.workflow_id']).toBe('wf_test');
    expect(execSpan.attributes['sunrise.user_id']).toBe(USER_ID);

    // Assert: each workflow.step carries step identity attributes
    const stepA = findSpan(
      tracer.spans,
      'workflow.step',
      (attrs) => attrs['sunrise.step_id'] === 'step_a'
    );
    expect(stepA.attributes['sunrise.step_type']).toBe('llm_call');
    expect(stepA.attributes['sunrise.execution_id']).toBe('exec_test');
    expect(stepA.status?.code).toBe('ok');

    const stepB = findSpan(
      tracer.spans,
      'workflow.step',
      (attrs) => attrs['sunrise.step_id'] === 'step_b'
    );
    expect(stepB.attributes['sunrise.step_type']).toBe('tool_call');
    expect(stepB.status?.code).toBe('ok');

    const stepC = findSpan(
      tracer.spans,
      'workflow.step',
      (attrs) => attrs['sunrise.step_id'] === 'step_c'
    );
    expect(stepC.attributes['sunrise.step_type']).toBe('llm_call');
    expect(stepC.status?.code).toBe('ok');

    // Assert: every workflow.step nests under workflow.execute — one trace
    // per execution, end-to-end, in OTLP backends.
    expect(execSpan.parentSpanId).toBeNull();
    for (const step of stepSpans) {
      expect(step.parentSpanId).toBe(execSpan.spanId);
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: Failed step → error status propagates
  // -----------------------------------------------------------------------

  it('failed step emits workflow.step with error status and workflow.execute with error status', async () => {
    // Arrange: executor that throws a non-retriable ExecutorError
    registerStepType('llm_call', async () => {
      throw new ExecutorError(
        'step_a',
        'provider_error',
        'LLM provider unreachable',
        undefined,
        false // non-retriable
      );
    });

    const workflow: { id: string; definition: WorkflowDefinition } = {
      id: 'wf_test',
      definition: {
        steps: [
          {
            id: 'step_a',
            name: 'Failing LLM step',
            type: 'llm_call',
            config: { prompt: 'fail me' },
            nextSteps: [],
          },
        ],
        entryStepId: 'step_a',
        errorStrategy: 'fail',
      },
    };

    // Act
    await collect(new OrchestrationEngine(), workflow);

    // Assert: the failing workflow.step has error status
    const stepSpan = findSpan(
      tracer.spans,
      'workflow.step',
      (attrs) => attrs['sunrise.step_id'] === 'step_a'
    );
    expect(stepSpan.status?.code).toBe('error');
    expect(stepSpan.status?.message).toContain('LLM provider unreachable');

    // Assert: workflow.execute also ends with error status
    const execSpan = findSpan(tracer.spans, 'workflow.execute');
    expect(execSpan.status?.code).toBe('error');

    // Assert: failing step still nests under workflow.execute
    expect(stepSpan.parentSpanId).toBe(execSpan.spanId);
  });

  // -----------------------------------------------------------------------
  // Test 3: Parallel branches
  // -----------------------------------------------------------------------

  it('parallel branches both nest under workflow.execute as siblings (not parent/child of each other)', async () => {
    // Arrange: entry step fans out to two parallel branches
    registerStepType('entry', async () => ({
      output: { fanned: true },
      tokensUsed: 0,
      costUsd: 0,
    }));
    registerStepType('branch_step', async () => ({
      output: { done: true },
      tokensUsed: 5,
      costUsd: 0.0005,
    }));

    const workflow: { id: string; definition: WorkflowDefinition } = {
      id: 'wf_test',
      definition: {
        steps: [
          {
            id: 'entry',
            name: 'Entry step',
            type: 'entry',
            config: {},
            nextSteps: [{ targetStepId: 'branch_a' }, { targetStepId: 'branch_b' }],
          },
          {
            id: 'branch_a',
            name: 'Branch A',
            type: 'branch_step',
            config: {},
            nextSteps: [],
          },
          {
            id: 'branch_b',
            name: 'Branch B',
            type: 'branch_step',
            config: {},
            nextSteps: [],
          },
        ],
        entryStepId: 'entry',
        errorStrategy: 'fail',
      },
    };

    // Act
    await collect(new OrchestrationEngine(), workflow);

    // Assert: there are three workflow.step spans (entry + branch_a + branch_b)
    const stepSpans = tracer.spans.filter((s) => s.name === 'workflow.step');
    expect(stepSpans).toHaveLength(3);

    // Assert: branch_a and branch_b are both present with ok status
    const branchA = findSpan(
      tracer.spans,
      'workflow.step',
      (attrs) => attrs['sunrise.step_id'] === 'branch_a'
    );
    const branchB = findSpan(
      tracer.spans,
      'workflow.step',
      (attrs) => attrs['sunrise.step_id'] === 'branch_b'
    );

    expect(branchA.status?.code).toBe('ok');
    expect(branchB.status?.code).toBe('ok');

    // Assert: both branches are direct children of workflow.execute — they
    // share a parent (siblings) but are not parent/child of each other.
    // AsyncLocalStorage forks per Promise (Node ≥ 18), so each branch sees
    // workflow.execute as its parent without entanglement.
    const execSpan = findSpan(tracer.spans, 'workflow.execute');
    expect(branchA.parentSpanId).toBe(execSpan.spanId);
    expect(branchB.parentSpanId).toBe(execSpan.spanId);
    expect(branchA.spanId).not.toBe(branchB.parentSpanId);
    expect(branchB.spanId).not.toBe(branchA.parentSpanId);
  });

  // -----------------------------------------------------------------------
  // Test 4: BudgetExceeded mid-run → workflow.execute is error
  // -----------------------------------------------------------------------

  it('BudgetExceeded mid-run ends workflow.execute with error status; the triggering step span is error', async () => {
    // Arrange: executor returns a high cost that exceeds the budget limit
    registerStepType('expensive_call', async () => ({
      output: { text: 'result' },
      tokensUsed: 1000,
      costUsd: 50.0, // far exceeds any budget
    }));

    const workflow: { id: string; definition: WorkflowDefinition } = {
      id: 'wf_test',
      definition: {
        steps: [
          {
            id: 'step_a',
            name: 'Expensive step',
            type: 'expensive_call',
            config: {},
            nextSteps: [],
          },
        ],
        entryStepId: 'step_a',
        errorStrategy: 'fail',
      },
    };

    // Act: set a very low budget limit so the step immediately exceeds it
    const events: ExecutionEvent[] = [];
    for await (const ev of new OrchestrationEngine().execute(
      workflow,
      {},
      { userId: USER_ID, budgetLimitUsd: 0.01 }
    )) {
      events.push(ev);
    }

    // Assert: workflow_failed event was emitted
    const failedEvent = events.find((e) => e.type === 'workflow_failed');
    expect(failedEvent).toBeDefined();

    // Assert: the step span ends with error status. The executor returned a valid result,
    // but executeSingleStep() returns { failed: true } after the post-merge budget check —
    // and the engine wraps executeSingleStep inside the step span. So the step span sees
    // singleResult.failed === true and calls endStepSpan({ code: 'error' }).
    const stepSpan = findSpan(
      tracer.spans,
      'workflow.step',
      (attrs) => attrs['sunrise.step_id'] === 'step_a'
    );
    expect(stepSpan.status?.code).toBe('error');

    // Assert: workflow.execute ends with error because the run failed
    const execSpan = findSpan(tracer.spans, 'workflow.execute');
    expect(execSpan.status?.code).toBe('error');

    // Assert: budget-failed step still nests under workflow.execute
    expect(stepSpan.parentSpanId).toBe(execSpan.spanId);
  });

  // -----------------------------------------------------------------------
  // Test 5: PausedForApproval → workflow.execute is ok
  // -----------------------------------------------------------------------

  it('PausedForApproval ends workflow.execute with ok status and the paused step span is ok', async () => {
    // Arrange: register a human_approval executor that throws PausedForApproval.
    // The production human-approval executor is not available after __resetRegistryForTests(),
    // so we register our own stub here.
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, {
        prompt: 'Please review and approve',
        previous: null,
      });
    });

    const workflow: { id: string; definition: WorkflowDefinition } = {
      id: 'wf_test',
      definition: {
        steps: [
          {
            id: 'approval_step',
            name: 'Human approval',
            type: 'human_approval',
            config: { prompt: 'Please review and approve' },
            nextSteps: [],
          },
        ],
        entryStepId: 'approval_step',
        errorStrategy: 'fail',
      },
    };

    // Act
    const events: ExecutionEvent[] = [];
    for await (const ev of new OrchestrationEngine().execute(workflow, {}, { userId: USER_ID })) {
      events.push(ev);
    }

    // Assert: approval_required event was emitted (pause is not a failure)
    const approvalEvent = events.find((e) => e.type === 'approval_required');
    expect(approvalEvent).toBeDefined();

    // Assert: no workflow_failed event — a pause is not a tracer-level error
    const failedEvent = events.find((e) => e.type === 'workflow_failed');
    expect(failedEvent).toBeUndefined();

    // Assert: the paused step span ends with ok status (PausedForApproval is not a
    // tracer error — the workflow continues from this pause point after approval)
    const stepSpan = findSpan(
      tracer.spans,
      'workflow.step',
      (attrs) => attrs['sunrise.step_id'] === 'approval_step'
    );
    expect(stepSpan.status?.code).toBe('ok');

    // Assert: workflow.execute ends with ok status
    const execSpan = findSpan(tracer.spans, 'workflow.execute');
    expect(execSpan.status?.code).toBe('ok');

    // Assert: paused step still nests under workflow.execute
    expect(stepSpan.parentSpanId).toBe(execSpan.spanId);
  });
});
