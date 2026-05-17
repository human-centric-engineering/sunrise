/**
 * Tests for `lib/orchestration/supervisor/index.ts` — the shared core
 * called by both the `supervisor` step executor and the retroactive
 * review endpoint.
 *
 * The executor's own tests (tests/unit/lib/orchestration/engine/executors/
 * supervisor.test.ts) exercise the runtime-toggle and `failOnVerdict`
 * glue. These tests target the core directly: prompt construction with
 * the various `includeStepOutputs` modes, serialisation fallbacks,
 * citation validator branches not reached by the executor wrapper, and
 * the `runSupervisorAssessment` orchestrator's retry / inconclusive
 * paths via a stub `llmCall` shim.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  buildProjection,
  buildPrompt,
  runSupervisorAssessment,
  tryParse,
  validateCitations,
  type LlmCallShim,
} from '@/lib/orchestration/supervisor';

// ─── Helpers ────────────────────────────────────────────────────────────────

function validReportJson(): string {
  return JSON.stringify({
    verdict: 'pass',
    score: 0.9,
    summary: 'Workflow met its objective.',
    strengths: [{ claim: 'good', evidenceStepId: 's1', evidenceQuote: 'applied' }],
    weaknesses: [
      {
        severity: 'low',
        claim: 'minor nit',
        evidenceStepId: 's1',
        evidenceQuote: 'applied',
        recommendation: 'fix',
      },
    ],
    anomalies: [],
    unverifiedAreas: [],
    confidence: 'high',
  });
}

function makeLlm(responses: Array<{ content: string; tokensUsed?: number; costUsd?: number }>) {
  const queue = [...responses];
  const calls: Array<{ prompt: string; temperature: number }> = [];
  const shim: LlmCallShim = (prompt, opts) => {
    calls.push({ prompt, temperature: opts.temperature });
    const next = queue.shift();
    if (!next) throw new Error('llmCall called more times than expected');
    return Promise.resolve({
      content: next.content,
      tokensUsed: next.tokensUsed ?? 50,
      costUsd: next.costUsd ?? 0.001,
    });
  };
  return { shim, calls };
}

// ─── buildProjection ────────────────────────────────────────────────────────

describe('buildProjection', () => {
  it('returns empty when stepOutputs has no keys', () => {
    const result = buildProjection({}, 'auto');
    expect(result.projection).toEqual([]);
    expect(result.mostRecentStepId).toBeNull();
  });

  it('mode "all": preserves long step outputs verbatim', () => {
    const long = 'X'.repeat(10_000);
    const { projection } = buildProjection({ s1: long, s2: 'short' }, 'all');
    expect(projection[0].output).toBe(long);
    expect(projection[0].output.length).toBe(long.length);
  });

  it('mode "auto": truncates outputs exceeding the 4KB cap', () => {
    const long = 'A'.repeat(10_000);
    const { projection } = buildProjection({ s1: long }, 'auto');
    expect(projection[0].output).toContain('truncated');
    expect(projection[0].output.length).toBeLessThan(long.length);
    // byte count reflects original input
    expect(projection[0].outputBytes).toBe(10_000);
  });

  it('mode "terminal-only": keeps last step full; heavily truncates earlier steps', () => {
    const long = 'X'.repeat(10_000);
    const { projection, mostRecentStepId } = buildProjection(
      { early: long, late: long },
      'terminal-only'
    );
    expect(mostRecentStepId).toBe('late');
    // early step is sampled to ~1KB
    expect(projection[0].output.length).toBeLessThan(long.length);
    // late step retained verbatim
    expect(projection[1].output).toBe(long);
  });

  it('reports outputBytes as the raw serialised size of the step output', () => {
    const obj = { x: 'hello world' };
    const { projection } = buildProjection({ s1: obj }, 'auto');
    expect(projection[0].outputBytes).toBe(Buffer.byteLength(JSON.stringify(obj, null, 2), 'utf8'));
  });
});

// ─── buildPrompt ────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  const base = {
    assessmentCriteria: 'audit rubric',
    redTeamPrompts: ['look for X'] as readonly string[],
    minWeaknesses: 1,
    projection: [],
    inputData: { foo: 'bar' },
    outputData: null,
    workflowId: 'wf_1',
    executionId: 'exec_1',
  };

  it('includes execution id, workflow id, assessment criteria, and red-team prompts', () => {
    const out = buildPrompt(base);
    expect(out).toContain('exec_1');
    expect(out).toContain('wf_1');
    expect(out).toContain('audit rubric');
    expect(out).toContain('look for X');
  });

  it('renders inputData as JSON', () => {
    const out = buildPrompt(base);
    expect(out).toContain('"foo": "bar"');
  });

  it('outputs friendly placeholder when outputData is null', () => {
    const out = buildPrompt(base);
    expect(out).toContain('workflow has not produced a terminal outputData');
  });

  it('outputs friendly placeholder when outputData is undefined', () => {
    const out = buildPrompt({ ...base, outputData: undefined });
    expect(out).toContain('workflow has not produced a terminal outputData');
  });

  it('renders outputData as JSON when present', () => {
    const out = buildPrompt({ ...base, outputData: { result: 'ok' } });
    expect(out).toContain('"result": "ok"');
  });

  it('serialise-failure on inputData falls back to placeholder string', () => {
    // Circular reference makes JSON.stringify throw inside the IIFE
    const cycle: Record<string, unknown> = { name: 'x' };
    cycle.self = cycle;
    const out = buildPrompt({ ...base, inputData: cycle });
    expect(out).toContain('could not serialize inputData');
  });

  it('serialise-failure on outputData falls back to placeholder string', () => {
    const cycle: Record<string, unknown> = { name: 'y' };
    cycle.self = cycle;
    const out = buildPrompt({ ...base, outputData: cycle });
    expect(out).toContain('could not serialize outputData');
  });

  it('uses "(no steps in trace yet)" when projection is empty', () => {
    const out = buildPrompt(base);
    expect(out).toContain('(no steps in trace yet)');
  });

  it('singular "entry" wording when minWeaknesses=1; plural "entries" otherwise', () => {
    expect(buildPrompt({ ...base, minWeaknesses: 1 })).toContain('at least 1 entry');
    expect(buildPrompt({ ...base, minWeaknesses: 3 })).toContain('at least 3 entries');
  });

  it('serialises each projection step with the bytes-total marker', () => {
    const out = buildPrompt({
      ...base,
      projection: [{ stepId: 's1', output: 'hi', outputBytes: 2 }],
    });
    expect(out).toContain('### Step: s1');
    expect(out).toContain('2 bytes total');
    expect(out).toContain('hi');
  });
});

// ─── tryParse ───────────────────────────────────────────────────────────────

describe('tryParse', () => {
  it('returns null on non-JSON input', () => {
    expect(tryParse('this is not JSON')).toBeNull();
  });

  it('returns null on JSON that fails the report shape schema', () => {
    expect(
      tryParse(JSON.stringify({ verdict: 'nope', score: 0.5, summary: 's', confidence: 'high' }))
    ).toBeNull();
  });

  it('parses a valid report', () => {
    const parsed = tryParse(validReportJson());
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBe('pass');
  });

  it('strips ```json … ``` fences when the model wraps its response', () => {
    const fenced = '```json\n' + validReportJson() + '\n```';
    const parsed = tryParse(fenced);
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBe('pass');
  });

  it('strips bare ``` … ``` fences (no language tag)', () => {
    const fenced = '```\n' + validReportJson() + '\n```';
    const parsed = tryParse(fenced);
    expect(parsed).not.toBeNull();
  });

  it('returns null for a malformed fenced block (open without close)', () => {
    expect(tryParse('```\nnot valid json without a close fence')).toBeNull();
  });

  it('extracts JSON from prose: "Here is my assessment: { ... }. Hope this helps!"', () => {
    const wrapped =
      "Here's my assessment of the workflow:\n\n" +
      validReportJson() +
      '\n\nLet me know if you need anything else.';
    const parsed = tryParse(wrapped);
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBe('pass');
  });

  it('extracts JSON when the model emits Markdown header before the JSON', () => {
    const wrapped = `## Supervisor verdict\n\n${validReportJson()}`;
    const parsed = tryParse(wrapped);
    expect(parsed).not.toBeNull();
  });

  it('handles JSON with nested braces inside string values', () => {
    // The balanced-brace scanner must respect string literals so `{`
    // inside a quote doesn't increment the depth counter.
    const tricky = JSON.stringify({
      verdict: 'pass',
      score: 0.9,
      summary: 'Found pattern { foo: 1 } in step output',
      strengths: [
        { claim: 'good', evidenceStepId: 's1', evidenceQuote: 'curly { brace } content' },
      ],
      weaknesses: [
        {
          severity: 'low',
          claim: 'minor',
          evidenceStepId: 's1',
          evidenceQuote: '}',
          recommendation: 'fix',
        },
      ],
      anomalies: [],
      unverifiedAreas: [],
      confidence: 'high',
    });
    const wrapped = `Here is the result: ${tricky} done.`;
    const parsed = tryParse(wrapped);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toContain('pattern { foo: 1 }');
  });

  it('still returns null for prose with no JSON object at all', () => {
    expect(tryParse('I have completed my analysis. Everything looks good.')).toBeNull();
  });
});

// ─── validateCitations ──────────────────────────────────────────────────────

describe('validateCitations', () => {
  it('passes through every citation when requireEvidenceCitations=false', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'pass',
        score: 0.9,
        summary: 's',
        strengths: [{ claim: 'x', evidenceStepId: 'ghost', evidenceQuote: 'whatever' }],
        weaknesses: [
          {
            severity: 'low',
            claim: 'y',
            evidenceStepId: 'ghost',
            evidenceQuote: 'whatever',
            recommendation: 'r',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'high',
      })
    )!;
    const { validatedReport, downgraded } = validateCitations(parsed, {}, 1, false);
    expect(downgraded).toBe(false);
    expect(validatedReport.invalidCitations).toBeUndefined();
    expect(validatedReport.strengths).toHaveLength(1);
    expect(validatedReport.weaknesses).toHaveLength(1);
  });

  it('accepts a weakness with null evidence (the no-defects escape hatch)', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'pass',
        score: 0.95,
        summary: 's',
        strengths: [],
        weaknesses: [
          {
            severity: 'low',
            claim: 'no defects found, verified: s1',
            evidenceStepId: null,
            evidenceQuote: null,
            recommendation: 'continue',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'high',
      })
    )!;
    const { validatedReport, downgraded } = validateCitations(parsed, { s1: 'x' }, 1, true);
    expect(downgraded).toBe(false);
    expect(validatedReport.weaknesses).toHaveLength(1);
    expect(validatedReport.weaknesses[0].evidenceStepId).toBeNull();
  });

  it('strips a weakness with one-of-two null fields (partial citation)', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'concerns',
        score: 0.5,
        summary: 's',
        strengths: [],
        weaknesses: [
          {
            severity: 'medium',
            claim: 'half-cited',
            evidenceStepId: 's1',
            evidenceQuote: null,
            recommendation: 'r',
          },
          {
            severity: 'medium',
            claim: 'other-half-cited',
            evidenceStepId: null,
            evidenceQuote: 'something',
            recommendation: 'r',
          },
          {
            severity: 'low',
            claim: 'a real one',
            evidenceStepId: 's1',
            evidenceQuote: 'real',
            recommendation: 'r',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'medium',
      })
    )!;
    const { validatedReport } = validateCitations(parsed, { s1: 'real output' }, 1, true);
    expect(validatedReport.weaknesses).toHaveLength(1);
    expect(validatedReport.weaknesses[0].claim).toBe('a real one');
    expect(validatedReport.invalidCitations).toHaveLength(2);
  });

  it('strips a strength whose quote is not a substring of the cited step output', () => {
    const parsed = tryParse(
      JSON.stringify({
        verdict: 'pass',
        score: 0.9,
        summary: 's',
        strengths: [
          { claim: 'x', evidenceStepId: 's1', evidenceQuote: 'NOT THERE' },
          { claim: 'y', evidenceStepId: 's1', evidenceQuote: 'real' },
        ],
        weaknesses: [
          {
            severity: 'low',
            claim: 'r',
            evidenceStepId: 's1',
            evidenceQuote: 'real',
            recommendation: 'r',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'medium',
      })
    )!;
    const { validatedReport } = validateCitations(parsed, { s1: 'real output' }, 1, true);
    expect(validatedReport.strengths).toHaveLength(1);
    expect(validatedReport.invalidCitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'quote_not_found' })])
    );
  });
});

// ─── runSupervisorAssessment ────────────────────────────────────────────────

describe('runSupervisorAssessment', () => {
  const baseParams = {
    stepOutputs: { s1: 'applied' },
    inputData: { foo: 'bar' },
    outputData: null,
    workflowId: 'wf_1',
    executionId: 'exec_1',
    assessmentCriteria: 'r',
    requireEvidenceCitations: true,
    minWeaknesses: 1,
    includeStepOutputs: 'auto' as const,
    temperature: 0.2,
    triggeredBy: 'in_workflow' as const,
  };

  it('happy path: builds prompt, parses response, returns report with triggeredBy', async () => {
    const { shim, calls } = makeLlm([
      { content: validReportJson(), tokensUsed: 100, costUsd: 0.01 },
    ]);
    const result = await runSupervisorAssessment({ ...baseParams, llmCall: shim });
    expect(result.report.verdict).toBe('pass');
    expect(result.report.triggeredBy).toBe('in_workflow');
    expect(result.tokensUsed).toBe(100);
    expect(result.costUsd).toBeCloseTo(0.01);
    expect(calls).toHaveLength(1);
    expect(calls[0].temperature).toBe(0.2);
  });

  it('retries at temperature 0 when the first response is malformed', async () => {
    const { shim, calls } = makeLlm([
      { content: 'not JSON', tokensUsed: 30, costUsd: 0.001 },
      { content: validReportJson(), tokensUsed: 80, costUsd: 0.005 },
    ]);
    const result = await runSupervisorAssessment({ ...baseParams, llmCall: shim });
    expect(calls).toHaveLength(2);
    expect(calls[1].temperature).toBe(0);
    expect(result.report.verdict).toBe('pass');
    expect(result.tokensUsed).toBe(110);
    expect(result.costUsd).toBeCloseTo(0.006);
  });

  it('returns inconclusive with parseFailure when both attempts are malformed', async () => {
    const { shim, calls } = makeLlm([
      { content: 'first malformed', tokensUsed: 20, costUsd: 0.001 },
      { content: 'still malformed', tokensUsed: 30, costUsd: 0.001 },
    ]);
    const result = await runSupervisorAssessment({ ...baseParams, llmCall: shim });
    expect(calls).toHaveLength(2);
    expect(result.report.verdict).toBe('inconclusive');
    expect(result.report.parseFailure?.rawResponse).toContain('still malformed');
    expect(result.report.triggeredBy).toBe('in_workflow');
  });

  it('caps the parseFailure rawResponse at 8000 bytes', async () => {
    const enormous = 'X'.repeat(20_000);
    const { shim } = makeLlm([{ content: enormous }, { content: enormous }]);
    const result = await runSupervisorAssessment({ ...baseParams, llmCall: shim });
    expect(result.report.parseFailure?.rawResponse.length).toBeLessThanOrEqual(8000);
  });

  it('passes triggeredBy="retroactive" through to the report when requested', async () => {
    const { shim } = makeLlm([{ content: validReportJson() }]);
    const result = await runSupervisorAssessment({
      ...baseParams,
      triggeredBy: 'retroactive',
      llmCall: shim,
    });
    expect(result.report.triggeredBy).toBe('retroactive');
  });

  it('downgrades verdict pass→concerns when citation stripping breaks the minWeaknesses floor', async () => {
    const bogusButValid = JSON.stringify({
      verdict: 'pass',
      score: 0.95,
      summary: 's',
      strengths: [],
      // Only weakness cites a non-existent step → stripped → floor of 1 broken.
      weaknesses: [
        {
          severity: 'low',
          claim: 'made up',
          evidenceStepId: 'ghost',
          evidenceQuote: 'q',
          recommendation: 'r',
        },
      ],
      anomalies: [],
      unverifiedAreas: [],
      confidence: 'high',
    });
    const { shim } = makeLlm([{ content: bogusButValid }]);
    const result = await runSupervisorAssessment({ ...baseParams, llmCall: shim });
    expect(result.report.verdict).toBe('concerns');
    expect(result.report.invalidCitations).toHaveLength(1);
  });

  it('propagates llmCall errors instead of catching them', async () => {
    const shim: LlmCallShim = vi.fn().mockRejectedValue(new Error('upstream timeout'));
    await expect(runSupervisorAssessment({ ...baseParams, llmCall: shim })).rejects.toThrow(
      'upstream timeout'
    );
  });
});
