/**
 * Tests for `lib/orchestration/engine/executors/guard.ts`.
 *
 * Covers:
 *   - Happy path LLM mode: PASS and FAIL responses routed correctly.
 *   - Regex mode: matching and non-matching input.
 *   - Schema mode: registered-schema pass/fail, issues surfaced,
 *     inputStepId targeting, missing schema, missing input step.
 *   - Missing rules → ExecutorError('missing_rules').
 *   - Invalid regex → ExecutorError('invalid_regex').
 *   - Flag mode: failure continues to pass edge.
 *   - Case-insensitive verdict parsing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { registerSchema, resetSchemaRegistry } from '@/lib/orchestration/schemas/registry';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  runLlmCall: vi.fn(),
  interpolatePrompt: vi.fn((template: string) => template),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeGuard } from '@/lib/orchestration/engine/executors/guard';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { message: 'Hello world' },
    stepOutputs: {},
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      withContext: vi.fn().mockReturnThis(),
    } as any,
    ...overrides,
  };
}

function makeGuardStep(overrides?: Partial<WorkflowStep['config']>): WorkflowStep {
  return {
    id: 'guard1',
    name: 'Test Guard',
    type: 'guard',
    config: {
      rules: 'No personal information allowed',
      mode: 'llm',
      failAction: 'block',
      ...overrides,
    },
    nextSteps: [
      { targetStepId: 'pass-step', condition: 'pass' },
      { targetStepId: 'fail-step', condition: 'fail' },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('LLM mode: routes to pass edge when model returns PASS', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'PASS\nInput is safe.',
      tokensUsed: 10,
      costUsd: 0.01,
      model: 'm',
    });

    const result = await executeGuard(makeGuardStep(), makeCtx());

    expect(result).toMatchObject({
      output: { passed: true, verdict: 'pass' },
      nextStepIds: ['pass-step'],
      tokensUsed: 10,
      costUsd: 0.01,
    });
  });

  it('LLM mode: forwards reasoningEffort from config to runLlmCall', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'PASS\nok',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    await executeGuard(makeGuardStep({ reasoningEffort: 'medium' }), makeCtx());

    const lastCall = vi.mocked(runLlmCall).mock.calls.at(-1)?.[1];
    expect(lastCall?.reasoningEffort).toBe('medium');
  });

  it('LLM mode: routes to fail edge when model returns FAIL', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'FAIL\nContains PII.',
      tokensUsed: 8,
      costUsd: 0.008,
      model: 'm',
    });

    const result = await executeGuard(makeGuardStep(), makeCtx());

    expect(result).toMatchObject({
      output: { passed: false, verdict: 'fail' },
      nextStepIds: ['fail-step'],
    });
  });

  it('LLM mode: case-insensitive verdict parsing', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'pass\nLooks good.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const result = await executeGuard(makeGuardStep(), makeCtx());
    expect(result.output).toMatchObject({ passed: true });
  });

  it('regex mode: passes when input matches pattern', async () => {
    const step = makeGuardStep({ mode: 'regex', rules: 'Hello' });
    const result = await executeGuard(step, makeCtx());

    expect(result).toMatchObject({
      output: { passed: true, verdict: 'pass' },
      nextStepIds: ['pass-step'],
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('regex mode: fails when input does not match pattern', async () => {
    const step = makeGuardStep({ mode: 'regex', rules: 'FORBIDDEN_WORD' });
    const result = await executeGuard(step, makeCtx());

    expect(result).toMatchObject({
      output: { passed: false, verdict: 'fail' },
      nextStepIds: ['fail-step'],
    });
  });

  it('regex mode: throws on invalid regex', async () => {
    const step = makeGuardStep({ mode: 'regex', rules: '[invalid(' });

    await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'invalid_regex',
    });
  });

  it('flag mode: routes to pass edge even on failure', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'FAIL\nFlagged issue.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const step = makeGuardStep({ failAction: 'flag' });
    const result = await executeGuard(step, makeCtx());

    expect(result.output).toMatchObject({ passed: false, failAction: 'flag' });
    expect(result.nextStepIds).toEqual(['pass-step']);
  });

  it('throws ExecutorError with code "missing_rules" when rules is empty', async () => {
    const step = makeGuardStep({ rules: '' });

    await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_rules',
    });
  });

  it('throws ExecutorError with code "missing_rules" when rules is absent', async () => {
    const step = makeGuardStep({ rules: undefined });

    await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_rules',
    });
  });

  // ── Schema mode ─────────────────────────────────────────────────────────
  // Schema mode is the deterministic alternative to LLM mode for
  // closed-set / shape checks. The registry is process-global so we
  // reset it before every schema-mode test to keep them isolated.
  describe('schema mode', () => {
    beforeEach(() => {
      resetSchemaRegistry();
    });

    it('passes when ctx.inputData matches the registered schema (no inputStepId)', async () => {
      registerSchema('demo', z.object({ message: z.string() }));
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'demo',
        // rules deliberately absent — schema mode keys off `schemaName`,
        // not `rules`. The executor must not demand `rules` here.
        rules: undefined,
      });

      const result = await executeGuard(step, makeCtx());

      expect(result).toMatchObject({
        output: { passed: true, verdict: 'pass' },
        nextStepIds: ['pass-step'],
        tokensUsed: 0,
        costUsd: 0,
      });
    });

    it('fails and surfaces Zod issues when ctx.inputData does not match', async () => {
      registerSchema('strict', z.object({ message: z.string(), missing: z.number() }));
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'strict',
        rules: undefined,
      });

      const result = await executeGuard(step, makeCtx());

      expect(result.output).toMatchObject({ passed: false, verdict: 'fail' });
      expect(result.nextStepIds).toEqual(['fail-step']);
      // The Zod issues array must be carried through so a downstream
      // retry's __retryContext can quote the precise field that failed.
      const out = result.output as { issues?: Array<{ path: string[]; message: string }> };
      expect(Array.isArray(out.issues)).toBe(true);
      expect(out.issues?.[0]?.path).toContain('missing');
    });

    it('inputStepId: validates the named step output instead of ctx.inputData', async () => {
      registerSchema('proposals', z.object({ items: z.array(z.string()) }));
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'proposals',
        inputStepId: 'producer',
        rules: undefined,
      });

      const ctx = makeCtx({
        inputData: { totally: 'unrelated' },
        stepOutputs: { producer: { items: ['a', 'b'] } },
      });

      const result = await executeGuard(step, ctx);
      expect(result.output).toMatchObject({ passed: true });
    });

    it('throws schema_not_found when the named schema is not registered', async () => {
      // Registry is reset; nothing registered.
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'absent',
        rules: undefined,
      });

      await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'schema_not_found',
      });
    });

    it('throws missing_schema_name when mode is schema but no schemaName is set', async () => {
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: undefined,
        rules: undefined,
      });

      await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'missing_schema_name',
      });
    });

    it('throws input_step_not_found when inputStepId references an uncompleted step', async () => {
      registerSchema('any', z.unknown());
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'any',
        inputStepId: 'never-ran',
        rules: undefined,
      });

      // ctx.stepOutputs is empty — the named step has not completed.
      await expect(executeGuard(step, makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'input_step_not_found',
      });
    });

    it('does NOT call the LLM in schema mode (deterministic, zero cost)', async () => {
      registerSchema('demo', z.object({ message: z.string() }));
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'demo',
        rules: undefined,
      });

      await executeGuard(step, makeCtx());

      // Schema mode must short-circuit before any LLM call — the
      // whole point of the mode is to avoid LLM hallucination on
      // closed-set checks. If a future regression accidentally
      // re-introduces a model call here, this assertion fires.
      expect(vi.mocked(runLlmCall)).not.toHaveBeenCalled();
    });

    // ── inputStepIds (compound mode) ───────────────────────────────────
    // Compound mode lets one guard validate the combined output of
    // several upstream parallel branches. Used by the audit workflow
    // to schema-check `analyse_chat` + `analyse_embedding` +
    // `discover_new_models` in a single step.
    it('inputStepIds: builds a compound record and validates against the schema', async () => {
      registerSchema(
        'audit-shape',
        z.object({
          branch_a: z.object({ a: z.string() }),
          branch_b: z.object({ b: z.number() }),
        })
      );
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'audit-shape',
        inputStepIds: ['branch_a', 'branch_b'],
        rules: undefined,
      });
      const ctx = makeCtx({
        stepOutputs: {
          branch_a: { a: 'ok' },
          branch_b: { b: 42 },
        },
      });

      const result = await executeGuard(step, ctx);

      expect(result.output).toMatchObject({ passed: true, verdict: 'pass' });
    });

    it('inputStepIds: fails with issues when one branch is malformed', async () => {
      registerSchema(
        'audit-shape',
        z.object({
          branch_a: z.object({ a: z.string() }),
          branch_b: z.object({ b: z.number() }),
        })
      );
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'audit-shape',
        inputStepIds: ['branch_a', 'branch_b'],
        rules: undefined,
      });
      const ctx = makeCtx({
        stepOutputs: {
          branch_a: { a: 'ok' },
          branch_b: { b: 'not-a-number' }, // wrong type
        },
      });

      const result = await executeGuard(step, ctx);

      expect(result.output).toMatchObject({ passed: false, verdict: 'fail' });
      const issues = (result.output as { issues?: Array<{ path: string[] }> }).issues;
      // Issue path should include the failing branch's stepId so the
      // retry context can quote precisely which producer to fix.
      expect(issues?.[0]?.path).toContain('branch_b');
    });

    it('inputStepIds: throws input_step_not_found when any referenced step has not completed', async () => {
      registerSchema('shape', z.object({}).passthrough());
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'shape',
        inputStepIds: ['branch_a', 'branch_missing'],
        rules: undefined,
      });
      const ctx = makeCtx({
        stepOutputs: { branch_a: {} },
      });

      // Compound mode names every referenced step, so a missing one
      // is a wiring bug, not a "we'll figure it out at parse time"
      // situation. Fail fast with the offending stepId.
      await expect(executeGuard(step, ctx)).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'input_step_not_found',
      });
    });

    // ── JSON-string unwrap ─────────────────────────────────────────────
    // `llm_call` and `agent_call` step outputs arrive as raw response
    // strings even when the prompt asks for JSON. The guard's schema
    // mode unwraps those before handing them to Zod — otherwise a
    // workflow like the audit template (where three parallel LLM steps
    // feed into a compound schema guard) would fail with the unhelpful
    // "expected object, received string" message on every run.
    it('inputStepIds: unwraps JSON-string outputs before schema validation', async () => {
      registerSchema(
        'audit-shape',
        z.object({
          branch_a: z.object({ a: z.string() }),
          branch_b: z.object({ b: z.number() }),
        })
      );
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'audit-shape',
        inputStepIds: ['branch_a', 'branch_b'],
        rules: undefined,
      });
      const ctx = makeCtx({
        stepOutputs: {
          // Both outputs are JSON-encoded strings, matching how
          // `llm_call` returns them in practice.
          branch_a: '{"a":"ok"}',
          branch_b: '{"b":42}',
        },
      });

      const result = await executeGuard(step, ctx);

      expect(result.output).toMatchObject({ passed: true, verdict: 'pass' });
    });

    it('inputStepId: unwraps a JSON-string output before schema validation', async () => {
      registerSchema('proposals', z.object({ items: z.array(z.string()) }));
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'proposals',
        inputStepId: 'producer',
        rules: undefined,
      });
      const ctx = makeCtx({
        stepOutputs: {
          producer: '{"items":["a","b","c"]}',
        },
      });

      const result = await executeGuard(step, ctx);

      expect(result.output).toMatchObject({ passed: true, verdict: 'pass' });
    });

    it('inputStepIds: malformed JSON in one branch falls through and fails validation cleanly', async () => {
      // Malformed JSON should NOT throw a SyntaxError — the unwrap
      // helper returns the original string on parse failure and Zod
      // produces the actionable "expected object, received string"
      // path the retry context can quote back to the producer.
      registerSchema(
        'audit-shape',
        z.object({
          branch_a: z.object({ a: z.string() }),
          branch_b: z.object({ b: z.number() }),
        })
      );
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'audit-shape',
        inputStepIds: ['branch_a', 'branch_b'],
        rules: undefined,
      });
      const ctx = makeCtx({
        stepOutputs: {
          branch_a: '{"a":"ok"}',
          branch_b: '{this is not valid json',
        },
      });

      const result = await executeGuard(step, ctx);

      expect(result.output).toMatchObject({ passed: false, verdict: 'fail' });
      const issues = (result.output as { issues?: Array<{ path: string[] }> }).issues;
      expect(issues?.[0]?.path).toContain('branch_b');
    });

    it('flag mode: schema failure still routes to pass edge', async () => {
      registerSchema('strict', z.object({ required: z.string() }));
      const step = makeGuardStep({
        mode: 'schema',
        schemaName: 'strict',
        failAction: 'flag',
        rules: undefined,
      });

      const result = await executeGuard(step, makeCtx());

      expect(result.output).toMatchObject({
        passed: false,
        failAction: 'flag',
        verdict: 'fail',
      });
      // Flag mode keeps execution flowing — fail verdict still goes
      // to the pass edge. The verdict and issues stay on the output
      // for trace inspection.
      expect(result.nextStepIds).toEqual(['pass-step']);
    });
  });
});
