/**
 * Tests for `lib/orchestration/engine/executors/report.ts`.
 *
 * The renderer is exercised by its own test file — these focus on the
 * executor glue: config validation, run-time toggle, output shape.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

import { executeReport } from '@/lib/orchestration/engine/executors/report';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: {},
    stepOutputs: { s1: 'first output', s2: { score: 0.9 } },
    variables: {},
    totalTokensUsed: 100,
    totalCostUsd: 0.005,
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
      withContext: vi.fn().mockReturnThis(),
    } as unknown as ExecutionContext['logger'],
    stepTelemetry: [],
    ...overrides,
  };
}

function step(config: Record<string, unknown> = {}): WorkflowStep {
  return {
    id: 'report_render',
    name: 'Render report',
    type: 'report',
    config,
    nextSteps: [],
  };
}

describe('executeReport', () => {
  it('emits markdown + byteLength + generatedAt on the happy path', async () => {
    const result = await executeReport(step(), makeCtx());
    const out = result.output as {
      markdown: string;
      byteLength: number;
      generatedAt: string;
    };
    expect(out.markdown).toContain('Execution report');
    expect(out.byteLength).toBeGreaterThan(0);
    expect(out.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.tokensUsed).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('short-circuits with expectedSkip when __generateReport=false', async () => {
    const ctx = makeCtx({ inputData: { __generateReport: false } });
    const result = await executeReport(step(), ctx);
    expect(result.skipped).toBe(true);
    expect(result.expectedSkip).toBe(true);
    expect(result.tokensUsed).toBe(0);
    expect(result.costUsd).toBe(0);
    // skipError feeds the trace UI's "Reason" cell — without it the
    // viewer falls back to "no reason captured". Output.reason is the
    // programmatic mirror.
    expect(result.skipError).toBe('report generation disabled at trigger time');
    expect(result.output).toMatchObject({
      skipped: true,
      reason: 'report generation disabled at trigger time',
    });
  });

  it('runs when __generateReport is absent (key undefined)', async () => {
    const result = await executeReport(step(), makeCtx());
    expect(result.skipped).toBeUndefined();
  });

  it.each([
    ['string "false"', 'false'],
    ['number 0', 0],
    ['null', null],
  ])(
    'does NOT skip when __generateReport is %s (only literal boolean false opts out)',
    async (_label, value) => {
      const ctx = makeCtx({ inputData: { __generateReport: value as never } });
      const result = await executeReport(step(), ctx);
      expect(result.skipped).toBeUndefined();
    }
  );

  it('ignores __generateReport=false when respectRuntimeOptOut=false', async () => {
    const ctx = makeCtx({ inputData: { __generateReport: false } });
    const result = await executeReport(step({ respectRuntimeOptOut: false }), ctx);
    expect(result.skipped).toBeUndefined();
  });

  it('renders every stepOutputs key as a step section', async () => {
    const ctx = makeCtx({ stepOutputs: { s1: 'a', s2: 'b', s3: 'c' } });
    const result = await executeReport(step(), ctx);
    const out = result.output as { markdown: string };
    expect(out.markdown).toContain('### 1. s1');
    expect(out.markdown).toContain('### 2. s2');
    expect(out.markdown).toContain('### 3. s3');
  });

  it('honours includeStepOutputs=all (no truncation)', async () => {
    const longOut = 'X'.repeat(10_000);
    const ctx = makeCtx({ stepOutputs: { s1: longOut } });
    const result = await executeReport(step({ includeStepOutputs: 'all' }), ctx);
    const out = result.output as { markdown: string };
    expect(out.markdown).toContain(longOut);
  });
});
