/**
 * LLM-as-judge scoring for a single Q/A turn.
 *
 * Scores three named metrics — faithfulness, groundedness, relevance —
 * by sending the user question, the AI's answer, and the citations the
 * answerer received to a judge LLM. One judge call per turn returns all
 * three scores together so it can reason about them as a set.
 *
 * **Faithfulness** — for each `[N]`-marked claim in the answer, does
 * citation [N]'s excerpt actually support it? Penalises unsupported
 * claims and hallucinated markers (e.g. `[9]` when only `[1]–[3]` were
 * supplied). Returns `null` when the answer has no inline markers (no
 * citations to verify).
 *
 * **Groundedness** — beyond inline markers, are the substantive claims
 * in the answer supported by *any* of the cited excerpts (or clearly
 * common knowledge)? Penalises free-floating assertions.
 *
 * **Relevance** — does the answer address what the user asked? Scored
 * 0..1: 0 entirely off-topic, 0.5 partial / tangential, 1 direct.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { Citation } from '@/types/orchestration';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { getProvider } from '@/lib/orchestration/llm/provider-manager';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';

type LlmProvider = Awaited<ReturnType<typeof getProvider>>;

const SCORING_TIMEOUT_MS = 10_000;
const SCORING_MAX_TOKENS = 2000;
const SCORING_TEMPERATURE = 0.2;
/** Citations excerpts can be long; cap what we ship to the judge. */
const MAX_EXCERPT_CHARS = 600;
const MAX_CITATIONS_IN_PROMPT = 12;

/** Per-metric score with the judge's reasoning. */
export interface MetricScore {
  /** 0..1, or `null` when the metric does not apply (e.g. faithfulness with no citations). */
  score: number | null;
  reasoning: string;
}

export interface MetricScores {
  faithfulness: MetricScore;
  groundedness: MetricScore;
  relevance: MetricScore;
}

export interface ScoreResponseParams {
  userQuestion: string;
  aiResponse: string;
  /** Citations as snapshotted onto the AiEvaluationLog at log-write time. */
  citations: Citation[];
  judgeProvider: LlmProvider;
  judgeModel: string;
  signal?: AbortSignal;
}

export interface ScoreResponseResult {
  scores: MetricScores;
  tokenUsage: { input: number; output: number };
  costUsd: number;
}

/**
 * Score one Q/A turn against the three rubrics. Throws on judge errors;
 * the caller decides whether to surface, swallow, or aggregate.
 */
export async function scoreResponse(params: ScoreResponseParams): Promise<ScoreResponseResult> {
  const messages = buildScoringMessages(params);

  const completion = await runStructuredCompletion<MetricScores>({
    provider: params.judgeProvider,
    model: params.judgeModel,
    messages,
    parse: parseMetricScores,
    retryUserMessage:
      'Your previous response was not valid JSON. Respond ONLY with a JSON object of the form ' +
      '{"faithfulness":{"score":0.0,"reasoning":"..."},"groundedness":{"score":0.0,"reasoning":"..."},' +
      '"relevance":{"score":0.0,"reasoning":"..."}}. Use null for "score" only when faithfulness ' +
      'has no inline citations to evaluate. No prose, no code fences.',
    temperature: SCORING_TEMPERATURE,
    maxTokens: SCORING_MAX_TOKENS,
    timeoutMs: SCORING_TIMEOUT_MS,
    onFinalFailure: () => new Error('Judge response was not valid JSON after retry'),
  });

  return {
    scores: completion.value,
    tokenUsage: completion.tokenUsage,
    costUsd: completion.costUsd,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildScoringMessages(params: ScoreResponseParams): LlmMessage[] {
  const trimmedCitations = params.citations.slice(0, MAX_CITATIONS_IN_PROMPT).map((c) => ({
    marker: c.marker,
    documentName: c.documentName,
    section: c.section,
    excerpt: truncate(c.excerpt, MAX_EXCERPT_CHARS),
  }));

  const systemContent = [
    'You are a strict evaluator scoring a single Q/A turn against three rubrics.',
    'You will be given a user question, an AI answer, and the list of cited sources the answerer received.',
    'Score each metric on a 0..1 scale and provide one short sentence of reasoning.',
    '',
    "FAITHFULNESS — For every inline `[N]` marker in the answer, does citation [N]'s excerpt actually",
    "support the claim it's attached to? Penalise unsupported claims and hallucinated markers (e.g.",
    '`[9]` when only `[1] [2] [3]` were supplied). Score = supported marked claims / total marked claims.',
    'If the answer contains no `[N]` markers at all, return `"score": null` with reasoning',
    '"no inline citations to evaluate".',
    '',
    'GROUNDEDNESS — Beyond inline markers, are the substantive claims in the answer supported by *any*',
    'of the cited excerpts (or clearly common knowledge)? Penalise free-floating assertions that are',
    'not traceable to evidence.',
    '',
    'RELEVANCE — Does the answer address what the user asked? 0 = entirely off-topic, 0.5 = partial /',
    'tangential, 1 = direct on-topic answer.',
    '',
    'Respond ONLY with valid JSON in this exact shape:',
    '{"faithfulness":{"score":0.0,"reasoning":"..."},"groundedness":{"score":0.0,"reasoning":"..."},"relevance":{"score":0.0,"reasoning":"..."}}',
    'No prose, no code fences.',
  ].join('\n');

  const userContent = [
    `Question: ${params.userQuestion}`,
    '',
    `Answer: ${params.aiResponse}`,
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

function parseMetricScores(raw: string): MetricScores | null {
  return tryParseJson<MetricScores>(raw, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const f = parseMetricEntry(obj.faithfulness, { allowNullScore: true });
    const g = parseMetricEntry(obj.groundedness, { allowNullScore: false });
    const r = parseMetricEntry(obj.relevance, { allowNullScore: false });
    if (f === null || g === null || r === null) return null;
    return { faithfulness: f, groundedness: g, relevance: r };
  });
}

function parseMetricEntry(value: unknown, opts: { allowNullScore: boolean }): MetricScore | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const rawScore = obj.score;
  const reasoning = obj.reasoning;
  if (typeof reasoning !== 'string') return null;

  if (rawScore === null) {
    return opts.allowNullScore ? { score: null, reasoning } : null;
  }
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return null;
  if (rawScore < 0 || rawScore > 1) return null;
  return { score: rawScore, reasoning };
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}
