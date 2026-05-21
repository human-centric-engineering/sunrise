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
  buildDisplayTrace,
  buildParallelBranchMap,
  computeTraceAggregates,
  rollupTelemetry,
  slowOutlierThresholdMs,
  type RunningStepRef,
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

  it("uses the LAST 'planner' entry for headline fields when any planner entries are present (orchestrator-style step)", () => {
    // Orchestrator pushes one planner call THEN delegates to two
    // sub-agents that push their own (untagged-then-post-tagged)
    // entries. The trace's headline must reflect the planner's
    // identity, not the last delegation's, even though all three
    // entries share `ctx.stepTelemetry` and the delegation entries
    // are appended later.
    const result = rollupTelemetry([
      telemetry({
        model: 'planner-model',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 200,
        requestParams: { maxTokens: 8192, temperature: 0.3, reasoningEffort: 'medium' },
        source: 'planner',
      }),
      telemetry({
        model: 'delegation-model-a',
        provider: 'anthropic',
        inputTokens: 30,
        outputTokens: 20,
        durationMs: 80,
        requestParams: { maxTokens: 4096, temperature: 0.7 },
        source: 'delegation',
      }),
      telemetry({
        model: 'delegation-model-b',
        provider: 'groq',
        inputTokens: 40,
        outputTokens: 25,
        durationMs: 90,
        requestParams: { maxTokens: 2048, temperature: 0.5 },
        source: 'delegation',
      }),
    ]);

    // Headline (model / provider / requestParams) reflects the planner.
    expect(result.model).toBe('planner-model');
    expect(result.provider).toBe('openai');
    expect(result.requestParams).toEqual({
      maxTokens: 8192,
      temperature: 0.3,
      reasoningEffort: 'medium',
    });
    // Totals sum across ALL entries — the trace row must still reflect
    // the full work the orchestrator step did (planner + delegations).
    expect(result.inputTokens).toBe(170);
    expect(result.outputTokens).toBe(95);
    expect(result.llmDurationMs).toBe(370);
  });

  it("falls through to 'last entry wins' when no entries carry a source tag (every other step type)", () => {
    // Untagged entries — the single-call step pattern. Behaviour must
    // be identical to before the tag was introduced: the LAST entry
    // wins for the headline fields.
    const result = rollupTelemetry([
      telemetry({ model: 'first', provider: 'openai', requestParams: { maxTokens: 100 } }),
      telemetry({ model: 'last', provider: 'anthropic', requestParams: { maxTokens: 200 } }),
    ]);
    expect(result.model).toBe('last');
    expect(result.provider).toBe('anthropic');
    expect(result.requestParams).toEqual({ maxTokens: 200 });
  });

  it('carries requestParams from the LAST turn (matches model/provider rollup semantics)', () => {
    const result = rollupTelemetry([
      telemetry({ requestParams: { maxTokens: 100, temperature: 0.2 } }),
      telemetry({
        requestParams: { maxTokens: 4096, temperature: 0.7, responseFormat: 'json_schema' },
      }),
    ]);
    expect(result.requestParams).toEqual({
      maxTokens: 4096,
      temperature: 0.7,
      responseFormat: 'json_schema',
    });
  });

  it('omits requestParams from the rollup when the last turn did not capture them', () => {
    // Single-turn rollup without requestParams — the field should be
    // absent so an empty spread into the trace entry doesn't write a
    // misleading sentinel value.
    const result = rollupTelemetry([telemetry()]);
    expect(result.requestParams).toBeUndefined();
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

describe('buildParallelBranchMap', () => {
  it('returns an empty map for a trace with no parallel steps', () => {
    const trace = [entry({ stepId: 's1' }), entry({ stepId: 's2' })];
    expect(buildParallelBranchMap(trace).size).toBe(0);
  });

  it('maps each immediate branch stepId to its parent parallel step', () => {
    const trace = [
      entry({
        stepId: 'fork-a',
        stepType: 'parallel',
        output: { parallel: true, branches: ['b1', 'b2'] },
      }),
      entry({ stepId: 'b1' }),
      entry({ stepId: 'b2' }),
    ];

    const map = buildParallelBranchMap(trace);
    expect(map.get('b1')).toBe('fork-a');
    expect(map.get('b2')).toBe('fork-a');
    expect(map.size).toBe(2);
  });

  it('handles multiple parallel forks with disjoint branches', () => {
    const trace = [
      entry({
        stepId: 'fork-a',
        stepType: 'parallel',
        output: { branches: ['a1'] },
      }),
      entry({
        stepId: 'fork-b',
        stepType: 'parallel',
        output: { branches: ['b1'] },
      }),
    ];
    const map = buildParallelBranchMap(trace);
    expect(map.get('a1')).toBe('fork-a');
    expect(map.get('b1')).toBe('fork-b');
  });

  it('ignores parallel entries whose output is null or not an object', () => {
    const trace = [
      entry({ stepId: 'fork-a', stepType: 'parallel', output: null }),
      entry({ stepId: 'fork-b', stepType: 'parallel', output: 'not an object' }),
      entry({ stepId: 'fork-c', stepType: 'parallel', output: 42 }),
    ];
    expect(buildParallelBranchMap(trace).size).toBe(0);
  });

  it('ignores parallel entries whose output.branches is missing or not an array', () => {
    const trace = [
      entry({ stepId: 'f1', stepType: 'parallel', output: { other: true } }),
      entry({ stepId: 'f2', stepType: 'parallel', output: { branches: 'oops' } }),
      entry({ stepId: 'f3', stepType: 'parallel', output: { branches: 42 } }),
    ];
    expect(buildParallelBranchMap(trace).size).toBe(0);
  });

  it('drops non-string branch IDs from the array', () => {
    const trace = [
      entry({
        stepId: 'fork',
        stepType: 'parallel',
        // Mixed array — only the string survives.
        output: { branches: ['good', 42, null, { x: 1 }] },
      }),
    ];
    const map = buildParallelBranchMap(trace);
    expect(map.size).toBe(1);
    expect(map.get('good')).toBe('fork');
  });

  it('ignores non-parallel step types even if they have an output.branches array', () => {
    const trace = [
      entry({
        stepId: 'pretender',
        stepType: 'llm_call',
        output: { branches: ['b1', 'b2'] },
      }),
    ];
    expect(buildParallelBranchMap(trace).size).toBe(0);
  });
});

describe('buildDisplayTrace', () => {
  function running(overrides: Partial<RunningStepRef> = {}): RunningStepRef {
    return {
      stepId: 'r1',
      stepType: 'llm_call',
      label: 'Running step',
      startedAt: '2026-05-05T00:00:00.000Z',
      completedAt: null,
      ...overrides,
    };
  }

  it('returns the persisted trace unchanged when nothing is running', () => {
    const trace = [entry({ stepId: 'a' })];
    expect(buildDisplayTrace(trace, [], 0)).toBe(trace);
  });

  it('appends one synthesised running row per in-flight step', () => {
    const trace = [entry({ stepId: 'a' })];
    const nowMs = new Date('2026-05-05T00:00:03.000Z').getTime();
    const result = buildDisplayTrace(
      trace,
      [running({ stepId: 'branch-1' }), running({ stepId: 'branch-2' })],
      nowMs
    );
    expect(result).toHaveLength(3);
    expect(result.slice(1).map((e) => e.stepId)).toEqual(['branch-1', 'branch-2']);
    expect(result.slice(1).every((e) => (e.status as string) === 'running')).toBe(true);
    // durationMs ticks against nowMs so the bar grows between polls.
    expect(result[1].durationMs).toBe(3_000);
  });

  it('drops persisted entries whose stepId is also reported as running', () => {
    // Defence against the rare race where the engine has just written the
    // persisted entry but the live-poll snapshot still reports it running.
    const trace = [entry({ stepId: 'racey', durationMs: 999 })];
    const result = buildDisplayTrace(
      trace,
      [running({ stepId: 'racey' })],
      new Date('2026-05-05T00:00:01.000Z').getTime()
    );
    expect(result).toHaveLength(1);
    expect(result[0].stepId).toBe('racey');
    expect(result[0].status as string).toBe('running');
    // Synthesised, not the persisted 999ms entry.
    expect(result[0].durationMs).toBe(1_000);
  });

  it('synthesises a finished-but-waiting branch as completed with real completedAt', () => {
    // A parallel branch that finished early — `completedAt` is set on the
    // running-step row so the strip can render the "waited for siblings"
    // hashed tail.
    const result = buildDisplayTrace(
      [],
      [
        running({
          stepId: 'fast-branch',
          startedAt: '2026-05-05T00:00:00.000Z',
          completedAt: '2026-05-05T00:00:02.000Z',
        }),
      ],
      new Date('2026-05-05T00:00:10.000Z').getTime() // "now" — way past completedAt
    );
    expect(result[0].status as string).toBe('completed');
    expect(result[0].completedAt).toBe('2026-05-05T00:00:02.000Z');
    expect(result[0].durationMs).toBe(2_000);
  });
});
