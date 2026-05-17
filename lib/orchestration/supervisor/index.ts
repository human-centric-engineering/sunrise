/**
 * Shared core for the neutral supervisor assessment.
 *
 * Two consumers:
 *  1. The `supervisor` step executor (in-workflow) — runs as a normal step.
 *  2. The `POST /executions/:id/review` admin endpoint (retroactive) —
 *     audits a completed execution after the fact.
 *
 * Both share the same prompt scaffolding, structured-output schema,
 * post-hoc citation validator, and verdict-downgrade rule. They differ
 * only in how they reach an LLM: the executor uses the engine's
 * `runLlmCall` (telemetry, cost logging, signal forwarding wired in);
 * the endpoint calls the LLM provider directly.
 *
 * The shared core is provider-agnostic — callers pass an `llmCall`
 * shim. This keeps the engine's `runLlmCall` machinery out of the
 * standalone admin path and avoids pulling Prisma into the executor's
 * critical path.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { z } from 'zod';

import type {
  SupervisorConfidence,
  SupervisorReport,
  SupervisorVerdict,
} from '@/types/orchestration';
import {
  DEFAULT_PER_STEP_CAP_BYTES,
  TERMINAL_HEAD_CAP_BYTES,
  sampleString,
  serialiseStepOutput,
} from '@/lib/orchestration/trace/truncate';

// Re-export so consumers that previously imported from this module
// keep working unchanged.
export { sampleString, serialiseStepOutput };

// ─── Trace projection ───────────────────────────────────────────────────────

export interface ProjectedStep {
  stepId: string;
  output: string;
  outputBytes: number;
}

export function buildProjection(
  stepOutputs: Record<string, unknown>,
  mode: 'auto' | 'all' | 'terminal-only'
): { projection: ProjectedStep[]; mostRecentStepId: string | null } {
  const stepIds = Object.keys(stepOutputs);
  if (stepIds.length === 0) return { projection: [], mostRecentStepId: null };
  const mostRecent = stepIds[stepIds.length - 1];

  const projection: ProjectedStep[] = stepIds.map((stepId) => {
    const raw = serialiseStepOutput(stepOutputs[stepId]);
    const bytes = Buffer.byteLength(raw, 'utf8');
    let truncated: string;
    if (mode === 'all') {
      truncated = raw;
    } else if (mode === 'terminal-only') {
      truncated = stepId === mostRecent ? raw : sampleString(raw, TERMINAL_HEAD_CAP_BYTES);
    } else {
      truncated = sampleString(raw, DEFAULT_PER_STEP_CAP_BYTES);
    }
    return { stepId, output: truncated, outputBytes: bytes };
  });

  return { projection, mostRecentStepId: mostRecent };
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

export const DEFAULT_RED_TEAM_PROMPTS = [
  'Silent retries that succeeded only after the budget was nearly exhausted.',
  'Steps with `expectedSkip: false` that failed — were they routine or signal?',
  'Internal contradictions across step outputs (step A claims X, step B asserts not-X).',
  'Guard / validator steps that passed despite obvious data issues.',
  'Capability calls that returned a success shape but applied zero changes.',
  'Reflect / agent loops that hit max iterations without converging.',
  'Inputs derived from missing fields where the executor silently substituted defaults.',
] as const;

const CALIBRATION_ANCHORS = `
Calibration anchors:
- PASS: every assertion the workflow makes is traceable to a step's output;
  no step failed unexpectedly; the final outcome matches the stated objective;
  the supervisor has at least one weakness/observation drawn from the trace
  (even healthy runs have small things to note).
- CONCERNS: the workflow likely succeeded but at least one of these is true:
  some claims lack solid evidence, an "expected" skip masked a real failure,
  reflection iterations were near the cap, or capability returns were not
  cross-checked against subsequent steps.
- FAIL: the workflow's terminal output contradicts an upstream step,
  a critical step failed silently, a guard let through data the rubric
  forbids, OR the supervisor cannot ground any of its assessment in the
  trace (a free-floating "looks fine to me" verdict counts as FAIL because
  it indicates the audit didn't actually happen).

Wrong-pass anti-example (DO NOT do this):
- A workflow that retried a step five times and got a degraded answer on the
  sixth attempt is NOT a pass. The fact that the final step has an output is
  not evidence that the workflow performed well. The retry storm itself is
  the signal.
`.trim();

export interface BuildPromptParams {
  assessmentCriteria: string;
  redTeamPrompts: readonly string[];
  minWeaknesses: number;
  projection: ProjectedStep[];
  inputData: unknown;
  outputData: unknown;
  workflowId: string;
  executionId: string;
}

export function buildPrompt(params: BuildPromptParams): string {
  const redTeamBlock = params.redTeamPrompts.map((p, i) => `  ${i + 1}. ${p}`).join('\n');

  const projectionBlock = params.projection
    .map(
      (s) =>
        `### Step: ${s.stepId}\nOutput (${s.outputBytes} bytes total, may be truncated):\n${s.output}`
    )
    .join('\n\n---\n\n');

  const inputBlock = ((): string => {
    try {
      return JSON.stringify(params.inputData, null, 2);
    } catch (err) {
      return `(could not serialize inputData: ${err instanceof Error ? err.message : 'unknown'})`;
    }
  })();

  const outputBlock = ((): string => {
    if (params.outputData === null || params.outputData === undefined) {
      return '(workflow has not produced a terminal outputData — supervisor is running mid-workflow or before finalize)';
    }
    try {
      return JSON.stringify(params.outputData, null, 2);
    } catch (err) {
      return `(could not serialize outputData: ${err instanceof Error ? err.message : 'unknown'})`;
    }
  })();

  return [
    `You are a neutral supervisor auditing the execution of a workflow. Your job is to deliver an honest, calibrated verdict on whether the workflow did its job. You are NOT the workflow's author. You have no incentive to make the workflow look good.`,
    ``,
    `Workflow execution id: ${params.executionId}`,
    `Workflow id: ${params.workflowId}`,
    ``,
    `## Assessment criteria (rubric — what "doing its job" means)`,
    params.assessmentCriteria,
    ``,
    `## Red-team checklist — at minimum, check for these failure modes:`,
    redTeamBlock,
    ``,
    CALIBRATION_ANCHORS,
    ``,
    `## Workflow inputData`,
    '```json',
    inputBlock,
    '```',
    ``,
    `## Workflow outputData`,
    '```json',
    outputBlock,
    '```',
    ``,
    `## Trace projection — every step that has completed so far, with truncated outputs`,
    projectionBlock || '(no steps in trace yet)',
    ``,
    `## Output requirements`,
    `Return a single JSON object matching this shape (NO prose around it, NO code fences):`,
    `{`,
    `  "verdict": "pass" | "concerns" | "fail",`,
    `  "score": number between 0 and 1,`,
    `  "summary": short paragraph stating the verdict and its load-bearing reason,`,
    `  "strengths": [ { "claim": "...", "evidenceStepId": "<stepId>", "evidenceQuote": "<verbatim substring of that step's output>" } ],`,
    `  "weaknesses": [ { "severity": "low"|"medium"|"high", "claim": "...", "evidenceStepId": "<stepId>"|null, "evidenceQuote": "<verbatim substring>"|null, "recommendation": "..." } ],`,
    `  "anomalies": [ { "stepId": "<stepId>", "observation": "..." } ],`,
    `  "unverifiedAreas": [ "<thing you could not assess>", ... ],`,
    `  "confidence": "low" | "medium" | "high"`,
    `}`,
    ``,
    `Hard requirements:`,
    `1. EVERY evidenceQuote must be a verbatim substring of the cited step's output. If you cannot quote, set evidenceQuote to null only inside weaknesses (never inside strengths).`,
    `2. weaknesses[] must contain at least ${params.minWeaknesses} entr${params.minWeaknesses === 1 ? 'y' : 'ies'}. If you genuinely find no defects, add a single entry with severity "low", evidenceStepId null, claim "no defects found and the following steps were verified: <list every stepId>", and evidenceQuote null. Do NOT use this escape hatch unless you actually verified every step.`,
    `3. unverifiedAreas[] lists what you could NOT assess. Be honest — an empty array means you verified everything, and you'll be judged on that.`,
    `4. Use trace evidence. A verdict not grounded in specific step outputs is a FAIL by definition.`,
  ].join('\n');
}

// ─── JSON parsing & schema validation ──────────────────────────────────────

export const reportShapeSchema = z.object({
  verdict: z.enum(['pass', 'concerns', 'fail']),
  score: z.number().min(0).max(1),
  summary: z.string().min(1),
  strengths: z
    .array(
      z.object({
        claim: z.string().min(1),
        evidenceStepId: z.string().min(1),
        evidenceQuote: z.string().min(1),
      })
    )
    .default([]),
  weaknesses: z
    .array(
      z.object({
        severity: z.enum(['low', 'medium', 'high']),
        claim: z.string().min(1),
        evidenceStepId: z.string().nullable(),
        evidenceQuote: z.string().nullable(),
        recommendation: z.string().min(1),
      })
    )
    .default([]),
  anomalies: z
    .array(z.object({ stepId: z.string().min(1), observation: z.string().min(1) }))
    .default([]),
  unverifiedAreas: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
});

export type ParsedReport = z.infer<typeof reportShapeSchema>;

function stripFences(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('```')) {
    const firstNl = trimmed.indexOf('\n');
    const last = trimmed.lastIndexOf('```');
    if (firstNl !== -1 && last > firstNl) {
      return trimmed.slice(firstNl + 1, last).trim();
    }
  }
  return trimmed;
}

/**
 * Find the first balanced top-level JSON object in `content` and
 * return that substring (or null). Used as a fallback when the LLM
 * wrapped the JSON in prose ("Here's my assessment: {...}. Let me know
 * if you need anything else.") — `JSON.parse` rejects the whole string
 * because of the trailing text, but the JSON inside is still
 * recoverable.
 *
 * Walks the string char by char, tracks string literals so braces
 * inside quotes don't confuse the depth counter.
 */
function extractFirstJsonObject(content: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return content.slice(start, i + 1);
      }
      if (depth < 0) return null; // malformed
    }
  }
  return null;
}

export function tryParse(content: string): ParsedReport | null {
  const cleaned = stripFences(content);

  // Attempt 1: parse the cleaned content directly. Covers the happy
  // path where the model returned pure JSON, optionally wrapped in
  // ``` fences.
  try {
    const direct = JSON.parse(cleaned) as unknown;
    const result = reportShapeSchema.safeParse(direct);
    if (result.success) return result.data;
  } catch {
    // fall through to extraction
  }

  // Attempt 2: extract the first balanced { ... } object from the
  // content and parse THAT. Handles "Here's the JSON: {...}. Hope
  // this helps!" and similar prose-wrapped responses.
  const extracted = extractFirstJsonObject(cleaned);
  if (extracted) {
    try {
      const raw = JSON.parse(extracted) as unknown;
      const result = reportShapeSchema.safeParse(raw);
      if (result.success) return result.data;
    } catch {
      // fall through
    }
  }

  return null;
}

// ─── Citation validator ─────────────────────────────────────────────────────

const VERDICT_DOWNGRADE: Record<SupervisorVerdict, SupervisorVerdict> = {
  pass: 'concerns',
  concerns: 'fail',
  fail: 'fail',
  inconclusive: 'inconclusive',
};

export interface ValidationResult {
  validatedReport: SupervisorReport;
  downgraded: boolean;
}

export function validateCitations(
  parsed: ParsedReport,
  stepOutputs: Record<string, unknown>,
  minWeaknesses: number,
  requireEvidenceCitations: boolean
): ValidationResult {
  const invalidCitations: NonNullable<SupervisorReport['invalidCitations']> = [];

  const validStrengths: SupervisorReport['strengths'] = [];
  parsed.strengths.forEach((s, index) => {
    if (!requireEvidenceCitations) {
      validStrengths.push(s);
      return;
    }
    const stepOut = stepOutputs[s.evidenceStepId];
    if (stepOut === undefined) {
      invalidCitations.push({
        location: 'strength',
        index,
        reason: 'unknown_step_id',
        evidenceStepId: s.evidenceStepId,
        evidenceQuote: s.evidenceQuote,
      });
      return;
    }
    if (!serialiseStepOutput(stepOut).includes(s.evidenceQuote)) {
      invalidCitations.push({
        location: 'strength',
        index,
        reason: 'quote_not_found',
        evidenceStepId: s.evidenceStepId,
        evidenceQuote: s.evidenceQuote,
      });
      return;
    }
    validStrengths.push(s);
  });

  const validWeaknesses: SupervisorReport['weaknesses'] = [];
  parsed.weaknesses.forEach((w, index) => {
    if (!requireEvidenceCitations) {
      validWeaknesses.push(w);
      return;
    }
    if (w.evidenceStepId === null && w.evidenceQuote === null) {
      validWeaknesses.push(w);
      return;
    }
    if (w.evidenceStepId === null || w.evidenceQuote === null) {
      invalidCitations.push({
        location: 'weakness',
        index,
        reason: 'unknown_step_id',
        evidenceStepId: w.evidenceStepId ?? '',
        evidenceQuote: w.evidenceQuote ?? '',
      });
      return;
    }
    const stepOut = stepOutputs[w.evidenceStepId];
    if (stepOut === undefined) {
      invalidCitations.push({
        location: 'weakness',
        index,
        reason: 'unknown_step_id',
        evidenceStepId: w.evidenceStepId,
        evidenceQuote: w.evidenceQuote,
      });
      return;
    }
    if (!serialiseStepOutput(stepOut).includes(w.evidenceQuote)) {
      invalidCitations.push({
        location: 'weakness',
        index,
        reason: 'quote_not_found',
        evidenceStepId: w.evidenceStepId,
        evidenceQuote: w.evidenceQuote,
      });
      return;
    }
    validWeaknesses.push(w);
  });

  const downgraded = validWeaknesses.length < minWeaknesses;
  const verdict: SupervisorVerdict = downgraded
    ? VERDICT_DOWNGRADE[parsed.verdict]
    : parsed.verdict;

  const validatedReport: SupervisorReport = {
    verdict,
    score: parsed.score,
    summary: parsed.summary,
    strengths: validStrengths,
    weaknesses: validWeaknesses,
    anomalies: parsed.anomalies,
    unverifiedAreas: parsed.unverifiedAreas,
    confidence: parsed.confidence as SupervisorConfidence,
    ...(invalidCitations.length > 0 ? { invalidCitations } : {}),
  };

  return { validatedReport, downgraded };
}

// ─── Assessment orchestrator ────────────────────────────────────────────────

export interface LlmCallShim {
  /** Issue one LLM call with the given prompt + temperature. Returns the
   *  raw response content + accumulated tokens / cost (provider-agnostic). */
  (
    prompt: string,
    opts: { temperature: number }
  ): Promise<{
    content: string;
    tokensUsed: number;
    costUsd: number;
  }>;
}

export interface RunSupervisorParams {
  /** Map of step.id → that step's output. For in-workflow: ctx.stepOutputs.
   *  For retroactive: reconstructed from the persisted executionTrace. */
  stepOutputs: Record<string, unknown>;
  inputData: unknown;
  outputData: unknown;
  workflowId: string;
  executionId: string;
  assessmentCriteria: string;
  redTeamPrompts?: readonly string[];
  requireEvidenceCitations: boolean;
  minWeaknesses: number;
  includeStepOutputs: 'auto' | 'all' | 'terminal-only';
  temperature: number;
  /** Provider-agnostic LLM shim. Implementations decide whether to bill
   *  cost, attach to a span, signal-forward, etc. */
  llmCall: LlmCallShim;
  /** Origin of this invocation — stamped onto the returned report. */
  triggeredBy: 'in_workflow' | 'retroactive';
}

export interface RunSupervisorResult {
  report: SupervisorReport;
  /** Total tokens across both attempts (one if first parsed, two if retried). */
  tokensUsed: number;
  costUsd: number;
}

/**
 * Build the prompt, call the LLM, retry on parse failure at temperature 0,
 * apply the citation validator + verdict-downgrade rule, and return the
 * SupervisorReport. Never throws on parse failure — produces an
 * `inconclusive` verdict so the operator still gets a signal.
 *
 * Provider errors / aborts bubble up: callers decide whether to catch
 * (the executor turns them into ExecutorError; the endpoint surfaces a 500).
 */
export async function runSupervisorAssessment(
  params: RunSupervisorParams
): Promise<RunSupervisorResult> {
  const { projection } = buildProjection(params.stepOutputs, params.includeStepOutputs);
  const prompt = buildPrompt({
    assessmentCriteria: params.assessmentCriteria,
    redTeamPrompts: params.redTeamPrompts ?? DEFAULT_RED_TEAM_PROMPTS,
    minWeaknesses: params.minWeaknesses,
    projection,
    inputData: params.inputData,
    outputData: params.outputData,
    workflowId: params.workflowId,
    executionId: params.executionId,
  });

  let totalTokens = 0;
  let totalCost = 0;

  const first = await params.llmCall(prompt, { temperature: params.temperature });
  totalTokens += first.tokensUsed;
  totalCost += first.costUsd;
  let parsed = tryParse(first.content);
  let rawForFailure = first.content;
  if (!parsed) {
    // Retry: rebuild the prompt with the failed response embedded and an
    // explicit "JSON only" preamble. Asking again at temperature 0 with
    // no acknowledgement of the previous failure usually produces the
    // same malformed response — models tend to repeat their last output
    // pattern. Showing the model what it returned and naming the problem
    // is far more effective.
    const retryPrompt =
      `Your previous response could not be parsed as JSON. ` +
      `Here is what you returned (verbatim, truncated to 4000 chars):\n\n` +
      `--- BEGIN PREVIOUS RESPONSE ---\n` +
      `${first.content.slice(0, 4000)}\n` +
      `--- END PREVIOUS RESPONSE ---\n\n` +
      `Common reasons your output failed parsing:\n` +
      `  - You wrapped the JSON in prose ("Here is my assessment:" before, "Hope this helps" after).\n` +
      `  - You included Markdown headers / lists / bold text instead of a JSON object.\n` +
      `  - You returned multiple JSON objects, or a JSON array at the top level.\n` +
      `  - You used trailing commas, single quotes, or unquoted keys.\n\n` +
      `Return ONLY a single JSON object matching the schema in the original prompt.\n` +
      `Start your response with { and end with } — no prose, no fences, no commentary.\n\n` +
      `--- ORIGINAL PROMPT (re-stated for context) ---\n${prompt}`;
    const retry = await params.llmCall(retryPrompt, { temperature: 0 });
    totalTokens += retry.tokensUsed;
    totalCost += retry.costUsd;
    rawForFailure = retry.content;
    parsed = tryParse(retry.content);
  }

  if (!parsed) {
    const inconclusive: SupervisorReport = {
      verdict: 'inconclusive',
      score: 0,
      summary:
        'Supervisor could not be parsed. Two attempts produced malformed JSON. See parseFailure for the raw response.',
      strengths: [],
      weaknesses: [],
      anomalies: [],
      unverifiedAreas: ['entire trace — supervisor output unparseable'],
      confidence: 'low',
      parseFailure: {
        rawResponse: rawForFailure.slice(0, 8000),
        reason: 'JSON did not satisfy reportShapeSchema after retry',
      },
      triggeredBy: params.triggeredBy,
    };
    return { report: inconclusive, tokensUsed: totalTokens, costUsd: totalCost };
  }

  const { validatedReport } = validateCitations(
    parsed,
    params.stepOutputs,
    params.minWeaknesses,
    params.requireEvidenceCitations
  );

  return {
    report: { ...validatedReport, triggeredBy: params.triggeredBy },
    tokensUsed: totalTokens,
    costUsd: totalCost,
  };
}
