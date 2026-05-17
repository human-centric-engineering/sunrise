import { describe, expect, it } from 'vitest';

import {
  buildInterpolationContextFromTrace,
  findPreviousStepId,
  hasTemplateTokens,
  resolveTemplatesIn,
} from '@/lib/orchestration/engine/interpolate-from-trace';
import type { ExecutionTraceEntry } from '@/types/orchestration';

function entry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  return {
    stepId: 's',
    stepType: 'llm_call',
    label: 'Step',
    status: 'completed',
    output: null,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-05T00:00:00.000Z',
    completedAt: '2026-05-05T00:00:01.000Z',
    durationMs: 1000,
    ...overrides,
  };
}

describe('buildInterpolationContextFromTrace', () => {
  it('keys step outputs by stepId, skipping null/undefined outputs', () => {
    const trace = [
      entry({ stepId: 'a', output: { value: 1 } }),
      entry({ stepId: 'b', output: null }),
      entry({ stepId: 'c', output: 'plain string' }),
    ];
    const ctx = buildInterpolationContextFromTrace(trace, {});
    expect(ctx.stepOutputs).toEqual({ a: { value: 1 }, c: 'plain string' });
    expect(ctx.inputData).toEqual({});
    expect(ctx.variables).toEqual({});
  });

  it('keeps inputData as an object only when it actually is one', () => {
    expect(buildInterpolationContextFromTrace([], 'a string').inputData).toEqual({});
    expect(buildInterpolationContextFromTrace([], [1, 2, 3]).inputData).toEqual({});
    expect(buildInterpolationContextFromTrace([], { foo: 'bar' }).inputData).toEqual({
      foo: 'bar',
    });
    expect(buildInterpolationContextFromTrace([], null).inputData).toEqual({});
  });
});

describe('findPreviousStepId', () => {
  it('returns the immediately-prior stepId', () => {
    const trace = [entry({ stepId: 'a' }), entry({ stepId: 'b' }), entry({ stepId: 'c' })];
    expect(findPreviousStepId(trace, 'c')).toBe('b');
    expect(findPreviousStepId(trace, 'b')).toBe('a');
  });

  it('returns undefined for the first step', () => {
    expect(findPreviousStepId([entry({ stepId: 'a' })], 'a')).toBeUndefined();
  });

  it('returns undefined when the target is not in the trace', () => {
    expect(findPreviousStepId([entry({ stepId: 'a' })], 'missing')).toBeUndefined();
  });
});

describe('hasTemplateTokens', () => {
  it('detects {{ in nested strings', () => {
    expect(hasTemplateTokens('hello {{name}}')).toBe(true);
    expect(hasTemplateTokens({ a: { b: ['plain', 'has {{x}}'] } })).toBe(true);
    expect(hasTemplateTokens('plain string')).toBe(false);
    expect(hasTemplateTokens({ a: 1, b: [false, null] })).toBe(false);
    expect(hasTemplateTokens(null)).toBe(false);
    expect(hasTemplateTokens(42)).toBe(false);
  });
});

describe('resolveTemplatesIn', () => {
  const ctx = buildInterpolationContextFromTrace(
    [entry({ stepId: 'load_models', output: { models: [{ id: 'gpt-5' }] } })],
    { user: 'alice' }
  );

  it('walks objects and substitutes string leaves containing {{', () => {
    const input = {
      prompt: 'For {{input.user}}: {{load_models.output}}',
      temperature: 0.2,
      nested: { description: 'plain string', other: 'see {{load_models.output}}' },
    };
    const result = resolveTemplatesIn(input, ctx) as {
      prompt: string;
      temperature: number;
      nested: { description: string; other: string };
    };
    expect(result.prompt).toContain('alice');
    expect(result.prompt).toContain('gpt-5');
    expect(result.temperature).toBe(0.2);
    expect(result.nested.description).toBe('plain string');
    expect(result.nested.other).toContain('gpt-5');
  });

  it('leaves arrays unchanged in structure', () => {
    const result = resolveTemplatesIn(['raw', 'has {{load_models.output}}'], ctx) as string[];
    expect(result[0]).toBe('raw');
    expect(result[1]).toContain('gpt-5');
  });

  it('returns the original value when there are no template tokens', () => {
    // Pure pass-through path keeps reference equality for primitive leaves.
    expect(resolveTemplatesIn('plain', ctx)).toBe('plain');
    expect(resolveTemplatesIn(42, ctx)).toBe(42);
    expect(resolveTemplatesIn(null, ctx)).toBe(null);
  });

  it('does not mutate the input object', () => {
    const input = { prompt: 'see {{load_models.output}}' };
    resolveTemplatesIn(input, ctx);
    expect(input.prompt).toBe('see {{load_models.output}}');
  });

  it('honours previousStepId for {{previous.output}}', () => {
    const trace = [
      entry({ stepId: 'first', output: 'first-output' }),
      entry({ stepId: 'second', output: 'second-output' }),
    ];
    const c = buildInterpolationContextFromTrace(trace, {});
    expect(resolveTemplatesIn('saw {{previous.output}}', c, 'first')).toBe('saw first-output');
    expect(resolveTemplatesIn('saw {{previous.output}}', c, undefined)).toBe('saw ');
  });
});
