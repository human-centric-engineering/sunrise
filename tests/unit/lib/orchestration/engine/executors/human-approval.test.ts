/**
 * Tests for `lib/orchestration/engine/executors/human-approval.ts`.
 *
 * Covers:
 *   - Throws PausedForApproval with prompt and previous step output.
 *   - Missing prompt → rejects with ExecutorError('missing_prompt').
 *   - No previous step output → payload has `previous: null`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeHumanApproval } from '@/lib/orchestration/engine/executors/human-approval';
import { ExecutorError, PausedForApproval } from '@/lib/orchestration/engine/errors';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: {},
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

function makeStep(configOverrides?: Record<string, unknown>): WorkflowStep {
  return {
    id: 'approval1',
    name: 'Test Approval',
    type: 'human_approval',
    config: {
      prompt: 'Approve?',
      ...configOverrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeHumanApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with PausedForApproval carrying prompt and previous step output', async () => {
    const ctx = makeCtx({ stepOutputs: { prev: 'content from prev step' } });
    const step = makeStep({ prompt: 'Approve?' });

    await expect(executeHumanApproval(step, ctx)).rejects.toBeInstanceOf(PausedForApproval);

    let thrown: unknown;
    try {
      await executeHumanApproval(step, ctx);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PausedForApproval);
    const paused = thrown as PausedForApproval;
    expect(paused.stepId).toBe('approval1');
    expect((paused.payload as Record<string, unknown>).prompt).toBe('Approve?');
    expect((paused.payload as Record<string, unknown>).previous).toBe('content from prev step');
  });

  it('rejects with ExecutorError("missing_prompt") when prompt is absent', async () => {
    const step = makeStep({ prompt: undefined });

    await expect(executeHumanApproval(step, makeCtx())).rejects.toBeInstanceOf(ExecutorError);

    let thrown: unknown;
    try {
      await executeHumanApproval(step, makeCtx());
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ExecutorError).code).toBe('missing_prompt');
    expect((thrown as ExecutorError).stepId).toBe('approval1');
  });

  it('rejects with ExecutorError("missing_prompt") when prompt is empty string', async () => {
    const step = makeStep({ prompt: '' });

    let thrown: unknown;
    try {
      await executeHumanApproval(step, makeCtx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExecutorError);
    expect((thrown as ExecutorError).code).toBe('missing_prompt');
  });

  it('rejects with ExecutorError("missing_prompt") when prompt is whitespace only', async () => {
    const step = makeStep({ prompt: '   ' });

    let thrown: unknown;
    try {
      await executeHumanApproval(step, makeCtx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExecutorError);
    expect((thrown as ExecutorError).code).toBe('missing_prompt');
  });

  it('payload has previous: null when there are no step outputs', async () => {
    const ctx = makeCtx({ stepOutputs: {} });

    let thrown: unknown;
    try {
      await executeHumanApproval(makeStep(), ctx);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PausedForApproval);
    const paused = thrown as PausedForApproval;
    expect((paused.payload as Record<string, unknown>).previous).toBeNull();
  });

  it('uses the last key in stepOutputs as the previous output', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        step_a: 'first output',
        step_b: 'second output',
      },
    });

    let thrown: unknown;
    try {
      await executeHumanApproval(makeStep(), ctx);
    } catch (err) {
      thrown = err;
    }

    const paused = thrown as PausedForApproval;
    expect((paused.payload as Record<string, unknown>).previous).toBe('second output');
  });

  it('always rejects — never resolves', async () => {
    // Even with a valid prompt, the executor always rejects (by design).
    const result = executeHumanApproval(makeStep(), makeCtx());
    await expect(result).rejects.toBeDefined();
  });

  it('interpolates {{stepId.output}} references in the prompt before pausing', async () => {
    // The approval prompt is composed in markdown by the workflow author
    // and references upstream step outputs via `{{stepId.output}}`. The
    // admin must see the resolved values, not the raw mustache template.
    const ctx = makeCtx({
      stepOutputs: {
        refine_findings: 'Refined audit:\n- Change A\n- Change B',
        score_audit: 8.5,
      },
    });
    const step = makeStep({
      prompt:
        'Review changes:\n\n{{refine_findings.output}}\n\nQuality score: {{score_audit.output}}',
    });

    let thrown: unknown;
    try {
      await executeHumanApproval(step, ctx);
    } catch (err) {
      thrown = err;
    }

    const paused = thrown as PausedForApproval;
    const prompt = (paused.payload as Record<string, unknown>).prompt as string;
    expect(prompt).toContain('Refined audit:');
    expect(prompt).toContain('- Change A');
    expect(prompt).toContain('Quality score: 8.5');
    // The raw mustache template must not survive into the payload.
    expect(prompt).not.toContain('{{refine_findings.output}}');
    expect(prompt).not.toContain('{{score_audit.output}}');
  });

  it('wraps object step outputs in fenced JSON blocks so markdown renders them readably', async () => {
    // Approval prompts are rendered as markdown in the admin queue. An
    // upstream step that emits a structured object (the audit
    // workflow's `discover_new_models`, `refine_findings`, etc.) used
    // to collapse to a single-line JSON blob inline with prose. Now
    // the markdown-aware interpolator wraps it in ```json``` so the
    // operator can actually read it.
    const ctx = makeCtx({
      stepOutputs: {
        discover_new_models: { newModels: [], reasoning: 'all known models registered' },
      },
    });
    const step = makeStep({
      prompt: '## Proposed New Models\n\n{{discover_new_models.output}}\n',
    });

    let thrown: unknown;
    try {
      await executeHumanApproval(step, ctx);
    } catch (err) {
      thrown = err;
    }
    const paused = thrown as PausedForApproval;
    const prompt = (paused.payload as Record<string, unknown>).prompt as string;
    expect(prompt).toContain('```json');
    expect(prompt).toContain('"newModels": []');
    expect(prompt).toContain('"reasoning": "all known models registered"');
    // Ensure the value is pretty-printed (newline between keys), not
    // collapsed to one line.
    expect(prompt).toMatch(/"newModels": \[\],\n\s+"reasoning"/);
  });

  it('unwraps top-level JSON-encoded string outputs before pretty-printing', async () => {
    // Some upstream steps store their final output as a JSON-encoded
    // string at the top level — render that as a proper code block
    // rather than as an escaped one-liner.
    const stepOutput = JSON.stringify({ passed: false, reason: 'fail' });
    const ctx = makeCtx({
      stepOutputs: { validate_proposals: stepOutput },
    });
    const step = makeStep({ prompt: '{{validate_proposals.output}}' });

    let thrown: unknown;
    try {
      await executeHumanApproval(step, ctx);
    } catch (err) {
      thrown = err;
    }
    const paused = thrown as PausedForApproval;
    const prompt = (paused.payload as Record<string, unknown>).prompt as string;
    // Pretty-printed, fenced, and the inner structure is readable
    // because the top-level string was JSON-parsed before stringifying.
    expect(prompt).toContain('```json');
    expect(prompt).toMatch(/"passed":\s*false/);
    expect(prompt).toMatch(/"reason":\s*"fail"/);
  });

  it('expands missing references to empty string (matches llm_call behaviour)', async () => {
    // If the workflow author references a step that never ran or has no
    // output, the reference resolves to empty — mirroring how the
    // existing interpolator handles llm_call prompts. Loud failures
    // here would block the workflow from pausing at all.
    const ctx = makeCtx({ stepOutputs: { foo: 'present' } });
    const step = makeStep({
      prompt: 'Available: {{foo.output}}. Missing: [{{nonexistent.output}}].',
    });

    let thrown: unknown;
    try {
      await executeHumanApproval(step, ctx);
    } catch (err) {
      thrown = err;
    }

    const paused = thrown as PausedForApproval;
    const prompt = (paused.payload as Record<string, unknown>).prompt as string;
    expect(prompt).toBe('Available: present. Missing: [].');
  });
});
