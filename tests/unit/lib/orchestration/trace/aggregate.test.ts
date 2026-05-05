/**
 * Trace aggregation helpers — pure-function unit tests.
 *
 * These cover both the engine-side rollup (telemetry → trace-entry
 * optional fields) and the UI-side aggregation (trace → summary
 * statistics). The functions are pure so we exercise edge cases at
 * source rather than through the full engine.
 */

import { describe, expect, it } from 'vitest';

import {
  computeTraceAggregates,
  rollupTelemetry,
  slowOutlierThresholdMs,
} from '@/lib/orchestration/trace/aggregate';
import type { ExecutionTraceEntry, LlmTelemetryEntry } from '@/types/orchestration';

function entry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  return {
    stepId: 's1',
    stepType: 'llm_call',
    label: 'Step',
    status: 'completed',
    output: null,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-05T00:00:00.000Z',
    completedAt: '2026-05-05T00:00:01.000Z',
    durationMs: 100,
    ...overrides,
  };
}

function telemetry(overrides: Partial<LlmTelemetryEntry> = {}): LlmTelemetryEntry {
  return {
    model: 'gpt-4o-mini',
    provider: 'openai',
    inputTokens: 10,
    outputTokens: 20,
    durationMs: 50,
    ...overrides,
  };
}

describe('rollupTelemetry', () => {
  it('returns an empty object for empty input so spreading is a no-op', () => {
    expect(rollupTelemetry([])).toEqual({});
  });

  it('returns last-turn model and provider for a single-turn rollup', () => {
    const result = rollupTelemetry([telemetry()]);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.provider).toBe('openai');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
    expect(result.llmDurationMs).toBe(50);
  });

  it('sums tokens and durations across multiple turns and reports the LAST turn for model/provider', () => {
    const entries = [
      telemetry({ model: 'a', provider: 'p1', inputTokens: 5, outputTokens: 7, durationMs: 10 }),
      telemetry({ model: 'b', provider: 'p2', inputTokens: 3, outputTokens: 4, durationMs: 20 }),
      telemetry({ model: 'c', provider: 'p3', inputTokens: 1, outputTokens: 2, durationMs: 30 }),
    ];
    const result = rollupTelemetry(entries);
    expect(result.model).toBe('c');
    expect(result.provider).toBe('p3');
    expect(result.inputTokens).toBe(9);
    expect(result.outputTokens).toBe(13);
    expect(result.llmDurationMs).toBe(60);
  });

  it('produces zeros (not undefined) for tokens/duration when entries exist with zero values', () => {
    const result = rollupTelemetry([telemetry({ inputTokens: 0, outputTokens: 0, durationMs: 0 })]);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.llmDurationMs).toBe(0);
  });
});

describe('computeTraceAggregates', () => {
  it('returns an empty-shape result for an empty trace', () => {
    const result = computeTraceAggregates([]);
    expect(result.stepTimeSumMs).toBe(0);
    expect(result.p50DurationMs).toBeNull();
    expect(result.p95DurationMs).toBeNull();
    expect(result.slowestStep).toBeNull();
    expect(result.byStepType).toEqual({});
  });

  it('sums stepTimeSumMs and skips percentiles for single-entry traces', () => {
    const result = computeTraceAggregates([entry({ durationMs: 200 })]);
    expect(result.stepTimeSumMs).toBe(200);
    expect(result.p50DurationMs).toBeNull();
    expect(result.p95DurationMs).toBeNull();
    expect(result.slowestStep).toEqual({ stepId: 's1', label: 'Step', durationMs: 200 });
  });

  it('computes nearest-rank percentiles correctly on a 10-entry trace', () => {
    const trace = Array.from({ length: 10 }, (_, i) =>
      entry({ stepId: `s${i}`, durationMs: (i + 1) * 100 })
    );
    const result = computeTraceAggregates(trace);
    // Sorted: 100, 200, ..., 1000.
    // p50 nearest-rank: ceil(0.5 * 10) - 1 = 4 → value 500.
    expect(result.p50DurationMs).toBe(500);
    // p95: ceil(0.95 * 10) - 1 = 9 → value 1000.
    expect(result.p95DurationMs).toBe(1000);
    expect(result.slowestStep?.stepId).toBe('s9');
    expect(result.slowestStep?.durationMs).toBe(1000);
    expect(result.stepTimeSumMs).toBe(5500);
  });

  it('breaks ties on slowestStep by first-seen order (stable)', () => {
    const trace = [
      entry({ stepId: 'a', durationMs: 100 }),
      entry({ stepId: 'b', durationMs: 100 }),
      entry({ stepId: 'c', durationMs: 100 }),
    ];
    const result = computeTraceAggregates(trace);
    expect(result.slowestStep?.stepId).toBe('a');
  });

  it('rolls per-step-type totals into byStepType', () => {
    const trace = [
      entry({ stepId: 'a', stepType: 'llm_call', tokensUsed: 50, durationMs: 100 }),
      entry({ stepId: 'b', stepType: 'llm_call', tokensUsed: 30, durationMs: 150 }),
      entry({ stepId: 'c', stepType: 'tool_call', tokensUsed: 0, durationMs: 75 }),
    ];
    const result = computeTraceAggregates(trace);
    expect(result.byStepType.llm_call).toEqual({ count: 2, tokens: 80, durationMs: 250 });
    expect(result.byStepType.tool_call).toEqual({ count: 1, tokens: 0, durationMs: 75 });
  });

  it('sums optional input/output/llmDuration only from entries that report them', () => {
    const trace = [
      entry({ inputTokens: 10, outputTokens: 20, llmDurationMs: 30 }),
      entry({
        /* no LLM fields */
      }),
      entry({ inputTokens: 5, outputTokens: 7, llmDurationMs: 12 }),
    ];
    const result = computeTraceAggregates(trace);
    expect(result.totalInputTokens).toBe(15);
    expect(result.totalOutputTokens).toBe(27);
    expect(result.totalLlmDurationMs).toBe(42);
  });
});

describe('slowOutlierThresholdMs', () => {
  it('returns null for traces with fewer than 5 entries', () => {
    expect(slowOutlierThresholdMs([])).toBeNull();
    expect(slowOutlierThresholdMs([entry()])).toBeNull();
    expect(slowOutlierThresholdMs([entry(), entry(), entry(), entry()])).toBeNull();
  });

  it('returns the p90 nearest-rank threshold for traces with at least 5 entries', () => {
    // Durations 100..1000 in ascending order. Sorted.
    // p90 nearest-rank on n=10: ceil(0.9 * 10) - 1 = 8 → value 900.
    const trace = Array.from({ length: 10 }, (_, i) =>
      entry({ stepId: `s${i}`, durationMs: (i + 1) * 100 })
    );
    expect(slowOutlierThresholdMs(trace)).toBe(900);
  });
});
