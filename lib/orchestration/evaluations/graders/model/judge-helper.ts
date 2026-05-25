/**
 * Shared judge invocation for model graders.
 *
 * Calls the configured judge model with a per-metric system prompt
 * and a Q/A/citations user prompt; expects a `{ score, reasoning }`
 * JSON object back. The retry-once-on-malformed contract from
 * `parse-structured.ts` is reused so a single bad response doesn't
 * fail the case.
 *
 * `customPromptOverride` lets the `custom_rubric` grader inject a
 * user-supplied rubric instead of one of the three named ones.
 */

import type { Citation } from '@/types/orchestration';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { JudgeBinding } from '@/lib/orchestration/evaluations/graders/types';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';

const JUDGE_TIMEOUT_MS = 10_000;
const JUDGE_MAX_TOKENS = 800;
const JUDGE_TEMPERATURE = 0.2;
const MAX_CITATIONS = 12;
const MAX_EXCERPT_CHARS = 600;

export interface JudgeRubric {
  /** Human-readable name shown in the judge's system prompt. */
  name: string;
  /** Sentence(s) describing what to score. */
  description: string;
  /** Scoring scale instructions — e.g. "0..1: 0 = …, 1 = …". */
  scale: string;
  /**
   * If true, the judge MAY return `score: null` (used by faithfulness
   * when the response has no inline citation markers).
   */
  allowNullScore?: boolean;
  /** Optional integer scale max — set by custom_rubric to e.g. 5. */
  scaleMax?: number;
}

export interface JudgeRubricInput {
  userInput: string;
  modelOutput: string;
  citations?: Citation[];
  judge: JudgeBinding;
  signal?: AbortSignal;
}

export interface JudgeRubricResult {
  score: number | null;
  reasoning: string;
  tokenUsage: { input: number; output: number };
  costUsd: number;
}

/** Single judge call producing one score+reasoning pair. */
export async function runJudgeForRubric(
  rubric: JudgeRubric,
  input: JudgeRubricInput
): Promise<JudgeRubricResult> {
  const messages = buildJudgeMessages(rubric, input);
  const max = rubric.scaleMax ?? 1;

  const completion = await runStructuredCompletion<{ score: number | null; reasoning: string }>({
    provider: input.judge.provider,
    model: input.judge.model,
    messages,
    parse: (raw) => parseJudgeOutput(raw, max, rubric.allowNullScore ?? false),
    retryUserMessage:
      'Your previous response was not valid JSON. Respond ONLY with a JSON object of the form ' +
      `{"score": <number>, "reasoning": "..."}. Score must be between 0 and ${max}` +
      (rubric.allowNullScore ? ', or null when the metric does not apply.' : '.') +
      ' No prose, no code fences.',
    temperature: JUDGE_TEMPERATURE,
    maxTokens: JUDGE_MAX_TOKENS,
    timeoutMs: JUDGE_TIMEOUT_MS,
    onFinalFailure: () =>
      new Error(`Judge response for "${rubric.name}" was not valid JSON after retry`),
    phase: 'scoring',
  });

  return {
    score: completion.value.score,
    reasoning: completion.value.reasoning,
    tokenUsage: completion.tokenUsage,
    costUsd: completion.costUsd,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildJudgeMessages(rubric: JudgeRubric, input: JudgeRubricInput): LlmMessage[] {
  const trimmedCitations = (input.citations ?? []).slice(0, MAX_CITATIONS).map((c) => ({
    marker: c.marker,
    documentName: c.documentName,
    section: c.section,
    excerpt: truncate(c.excerpt, MAX_EXCERPT_CHARS),
  }));

  const max = rubric.scaleMax ?? 1;
  const min = 0;
  const systemContent = [
    `You are a strict evaluator scoring an AI answer against ONE rubric: ${rubric.name}.`,
    rubric.description,
    `Scoring scale: ${rubric.scale}`,
    rubric.allowNullScore
      ? `If the metric cannot be evaluated for this answer (see the rubric), return "score": null.`
      : null,
    'Respond ONLY with valid JSON in this exact shape:',
    rubric.allowNullScore
      ? `{"score": <number ${min}..${max} or null>, "reasoning": "<one short sentence>"}`
      : `{"score": <number ${min}..${max}>, "reasoning": "<one short sentence>"}`,
    'No prose, no code fences.',
  ]
    .filter((s): s is string => s !== null)
    .join('\n');

  const userContent = [
    `Question: ${input.userInput}`,
    '',
    `Answer: ${input.modelOutput}`,
    '',
    'Cited sources:',
    trimmedCitations.length > 0
      ? JSON.stringify(trimmedCitations, null, 2)
      : '(no cited sources — the answerer was not given any retrieved context)',
  ].join('\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

function parseJudgeOutput(
  raw: string,
  scaleMax: number,
  allowNullScore: boolean
): { score: number | null; reasoning: string } | null {
  return tryParseJson<{ score: number | null; reasoning: string }>(raw, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.reasoning !== 'string') return null;
    if (obj.score === null) {
      return allowNullScore ? { score: null, reasoning: obj.reasoning } : null;
    }
    if (typeof obj.score !== 'number' || !Number.isFinite(obj.score)) return null;
    if (obj.score < 0 || obj.score > scaleMax) return null;
    return { score: obj.score, reasoning: obj.reasoning };
  });
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}…`;
}
