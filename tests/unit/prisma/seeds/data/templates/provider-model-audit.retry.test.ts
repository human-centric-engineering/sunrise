/**
 * Provider-model-audit template — what a guard retry tells the producers
 * (t-1076).
 *
 * On a dev run (execution `cmwpgdkyt0000r2sbhcgc55dh`) the analysers, on a
 * small default model, proposed every price they could not find as a change
 * to `null` with no sources. The schema guard found 38 issues per attempt,
 * but the retry handed the producers only the first, so both retries failed
 * the same way. These tests run the template's own `validate_proposals` step
 * through the real guard executor and the real `audit-proposals` schema,
 * then render each producer's retry prompt with the real interpolator.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/orchestration/engine/interpolate-prompt')
  >('@/lib/orchestration/engine/interpolate-prompt');
  return { runLlmCall: vi.fn(), interpolatePrompt: actual.interpolatePrompt };
});

import { executeGuard } from '@/lib/orchestration/engine/executors/guard';
import { interpolatePrompt } from '@/lib/orchestration/engine/interpolate-prompt';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { createMockLogger } from '@/tests/types/mocks';
import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';

const steps = PROVIDER_MODEL_AUDIT_TEMPLATE.workflowDefinition.steps;
const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
const promptOf = (id: string): string => {
  const config = byId[id].config as { prompt?: string; message?: string };
  return config.prompt ?? config.message ?? '';
};

/** A price "change" to nothing, as gpt-4o-mini produced for every model. */
const nullPrice = (field: string) => ({
  field,
  currentValue: null,
  proposedValue: null,
  reason: 'Price not available from current sources',
  confidence: 'low',
  sources: [],
});

/** analyse_chat's output on the failed run, cut to two models. */
const FAILED_CHAT_OUTPUT = JSON.stringify({
  models: [
    {
      model_id: 'openai-gpt-4o-mini',
      modelName: 'GPT-4o Mini',
      providerSlug: 'openai',
      changes: [nullPrice('inputCostPerMillionTokens'), nullPrice('outputCostPerMillionTokens')],
      overallConfidence: 'low',
      reasoning: 'No pricing source found.',
    },
    {
      model_id: 'openai-gpt-4-1',
      modelName: 'GPT-4.1',
      providerSlug: 'openai',
      changes: [nullPrice('costPerMillionTokens')],
      overallConfidence: 'low',
      reasoning: 'No pricing source found.',
    },
  ],
  deactivateModels: [],
});

function makeCtx(stepOutputs: Record<string, unknown>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: {},
    stepOutputs,
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: createMockLogger(),
  };
}

const PRODUCERS = ['analyse_chat', 'analyse_embedding', 'discover_new_models'] as const;

describe('provider-model-audit template — guard retry (t-1076)', () => {
  it("a retry shows each producer every issue the guard found and that producer's previous output", async () => {
    const stepOutputs: Record<string, unknown> = {
      analyse_chat: FAILED_CHAT_OUTPUT,
      analyse_embedding: JSON.stringify({ models: [], deactivateModels: [] }),
      discover_new_models: JSON.stringify({ newModels: [], reasoning: 'None missing.' }),
    };
    const guard = await executeGuard(byId['validate_proposals'], makeCtx(stepOutputs));
    const output = guard.output as {
      passed: boolean;
      reason: string;
      issues: Array<{ path: PropertyKey[]; message: string }>;
    };
    expect(output.passed).toBe(false);
    // Three null-price changes: each lacks sources and a numeric price, and
    // the blended field is not an auditable one — several issues, not one.
    expect(output.issues.length).toBeGreaterThan(3);

    // What the engine stores on the retry back-edge (orchestration-engine.ts).
    const ctx = makeCtx(stepOutputs);
    ctx.variables.__retryContext = {
      fromStep: 'validate_proposals',
      attempt: 1,
      maxRetries: 2,
      failureReason: output.reason,
    };

    const chat = interpolatePrompt(promptOf('analyse_chat'), ctx);
    for (const issue of output.issues) {
      expect(chat).toContain(`${issue.path.map(String).join('.')}: ${issue.message}`);
    }
    expect(chat).toContain('sources must be non-empty');
    expect(chat).toContain('"model_id":"openai-gpt-4-1"'); // its previous output, so paths resolve
    expect(chat).toContain('A problem whose path begins with `analyse_chat` is about your output');
    expect(chat).toContain('by the `validate_proposals` check');

    // Each producer is pointed at its own lines and shown its own output.
    for (const id of PRODUCERS) {
      const rendered = interpolatePrompt(promptOf(id), ctx);
      expect(rendered, id).toContain(
        `A problem whose path begins with \`${id}\` is about your output`
      );
      expect(rendered, id).toContain(String(stepOutputs[id]));
    }
  });

  it('a first attempt carries no retry block', () => {
    const ctx = makeCtx({});
    for (const id of PRODUCERS) {
      const rendered = interpolatePrompt(promptOf(id), ctx);
      expect(rendered, id).not.toContain('previous attempt was rejected');
      expect(rendered, id).not.toContain('Your previous output');
    }
  });
});

describe('provider-model-audit template — no change without a value (t-1076)', () => {
  it.each(['analyse_chat', 'analyse_embedding'])(
    '%s tells the model to leave out a field it has no new value for',
    (id) => {
      const prompt = promptOf(id);
      expect(prompt).toContain('**Only propose a change you can make.**');
      expect(prompt).toContain(
        'never propose `null`, an empty value, "unknown" or "not available"'
      );
      expect(prompt).toContain('an empty `models` array is a good result');
    }
  );

  it.each(['analyse_chat', 'analyse_embedding'])(
    '%s keeps the price-pair restatement as the one exception to leaving a field out',
    (id) => {
      expect(promptOf(id)).toContain(
        'The one exception is a price: when one of the pair changes, the pricing rules below say to restate the other at its current value'
      );
    }
  );

  it('load_models copies every field a change can be proposed to, so currentValue is read not guessed', () => {
    const prompt = promptOf('load_models');
    for (const field of [
      'description',
      'deploymentProfiles',
      'dimensions',
      'quality',
      'schemaCompatible',
      'tierRole',
      'bestRole',
    ]) {
      expect(prompt, field).toContain(field);
    }
  });

  it('no step asks for or mentions the legacy blended price', () => {
    // `inputCostPerMillionTokens` contains `CostPerMillionTokens` (capital C);
    // the blended field is the bare lower-case name.
    const blended = /(^|[^A-Za-z])costPerMillionTokens/;
    for (const step of steps) {
      expect(JSON.stringify(step.config), step.id).not.toMatch(blended);
    }
  });
});

describe('provider-model-audit template — retry feedback that names no path (t-1076 review)', () => {
  const rationaleFailure =
    'The tierRole change on GPT-4.1 does not engage with "worker": {"field":"tierRole","currentValue":"worker"}';

  function ctxAfter(fromStep: string, failureReason: string, previous: Record<string, unknown>) {
    const ctx = makeCtx(previous);
    ctx.variables.__retryContext = { fromStep, attempt: 1, maxRetries: 2, failureReason };
    return ctx;
  }

  it('tells each producer that a pathless complaint is theirs when it quotes their output', () => {
    const ctx = ctxAfter('validate_rationale', rationaleFailure, {
      analyse_chat: FAILED_CHAT_OUTPUT,
    });
    for (const id of PRODUCERS) {
      const rendered = interpolatePrompt(promptOf(id), ctx);
      expect(rendered, id).toContain(rationaleFailure);
      expect(rendered, id).toContain('by the `validate_rationale` check');
      expect(rendered, id).toContain(
        'A problem that gives no path — a check quoting a change, say — is yours if it quotes something from your previous output.'
      );
      // The old wording told every producer to ignore anything not starting
      // with its own id, which a rationale complaint never does.
      expect(rendered, id).not.toContain('so ignore them');
    }
  });

  it('a root-level issue (output not an object) is explained as the whole output', () => {
    const ctx = ctxAfter(
      'validate_proposals',
      'Schema validation failed at analyse_chat: expected object, received string',
      { analyse_chat: 'Here is the JSON: ```json\n{}\n```' }
    );
    const rendered = interpolatePrompt(promptOf('analyse_chat'), ctx);
    expect(rendered).toContain(
      'A path that is just `analyse_chat` means your whole output was wrong'
    );
    // The previous output's own triple fence sits inside a four-backtick one.
    expect(rendered).toContain('````\nHere is the JSON: ```json\n{}\n```\n````');
  });

  it('a producer none of the problems name is told to return its previous output unchanged', () => {
    const ctx = ctxAfter(
      'validate_proposals',
      'Schema validation failed at discover_new_models: x',
      {}
    );
    for (const id of PRODUCERS) {
      expect(interpolatePrompt(promptOf(id), ctx), id).toContain(
        'If none of the problems are yours, return your previous output unchanged.'
      );
    }
  });

  it('the rationale check is told to set aside a schema complaint that has since passed', () => {
    const rules = (byId['validate_rationale'].config as { rules: string }).rules;
    const ctx = ctxAfter('validate_proposals', 'Schema validation failed with 38 issues:', {});
    (ctx.variables.__retryContext as { attempt: number }).attempt = 2;
    const rendered = interpolatePrompt(rules, ctx);
    expect(rendered).toContain('this is retry 2 of 2');
    expect(rendered).toContain('by the `validate_proposals` check');
    expect(rendered).toContain(
      "If that check was `validate_proposals`, it was about the proposals' structure and they have since passed it: ignore it"
    );
  });
});
