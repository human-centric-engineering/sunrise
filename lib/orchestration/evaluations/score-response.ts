/**
 * LLM-as-judge scoring for a single Q/A turn in a MANUAL evaluation session.
 *
 * Drives three seeded judge agents in parallel — relevance, faithfulness,
 * groundedness — and returns one combined `MetricScores` envelope. The
 * 3 judges run as parallel `streamChat` calls; each call's cost lands on
 * the respective judge agent via the standard `CostOperation.CHAT` row,
 * so analytics can attribute spend per judge without bespoke cost
 * accounting here.
 *
 * Refactored in Phase 1.5: previously this was a single bundled judge
 * call returning all three scores together. The bundled prompt couldn't
 * be edited by admins (it was a code string) and couldn't carry
 * knowledge / capabilities. Splitting into three judge-agent calls is
 * the small price for the visibility + control admins get in exchange.
 *
 * The batch-run path uses the same judge agents via the `judge_agent`
 * grader entry in the registry. This file is the manual-session
 * analogue — keeps the existing `complete-session.ts` flow stable while
 * the underlying machinery is unified.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { Citation } from '@/types/orchestration';
import { logger } from '@/lib/logging';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';

/** Slugs of the three seeded judge agents the manual session uses. */
export const MANUAL_SESSION_JUDGE_SLUGS = {
  faithfulness: 'eval-judge-faithfulness',
  groundedness: 'eval-judge-groundedness',
  relevance: 'eval-judge-relevance',
} as const;

const MAX_CITATIONS_IN_PROMPT = 12;
const MAX_EXCERPT_CHARS = 600;

/** Per-metric score with the judge's reasoning + (optional) chain-of-thought trace. */
export interface MetricScore {
  /** 0..1, or `null` when the metric does not apply (e.g. faithfulness with no citations). */
  score: number | null;
  reasoning: string;
  /** G-Eval chain-of-thought trace — present when the judge returned one. */
  evaluationSteps?: string[];
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
  /** User who owns the evaluation session — judge calls attribute to them. */
  userId: string;
  signal?: AbortSignal;
}

export interface ScoreResponseResult {
  scores: MetricScores;
  /** Sum of the three judge calls' costs. */
  costUsd: number;
}

/**
 * Score one Q/A turn against the three named rubrics by invoking the
 * seeded judge agents in parallel. Per-judge errors degrade to a null
 * score on that metric rather than failing the whole call; if ALL
 * three fail (e.g. user has no active LLM provider), throws.
 */
export async function scoreResponse(params: ScoreResponseParams): Promise<ScoreResponseResult> {
  const userMessage = buildJudgePrompt(params);

  const [faithfulnessResult, groundednessResult, relevanceResult] = await Promise.all([
    runJudge(MANUAL_SESSION_JUDGE_SLUGS.faithfulness, userMessage, params.userId),
    runJudge(MANUAL_SESSION_JUDGE_SLUGS.groundedness, userMessage, params.userId),
    runJudge(MANUAL_SESSION_JUDGE_SLUGS.relevance, userMessage, params.userId),
  ]);

  const anySucceeded = faithfulnessResult.ok || groundednessResult.ok || relevanceResult.ok;
  if (!anySucceeded) {
    const firstError = faithfulnessResult.ok
      ? null
      : (faithfulnessResult.errorMessage ?? 'unknown judge failure');
    throw new Error(firstError ?? 'All three judges failed to produce a score');
  }

  return {
    scores: {
      faithfulness: faithfulnessResult.ok
        ? faithfulnessResult.score
        : nullScore(faithfulnessResult),
      groundedness: groundednessResult.ok
        ? groundednessResult.score
        : nullScore(groundednessResult),
      relevance: relevanceResult.ok ? relevanceResult.score : nullScore(relevanceResult),
    },
    costUsd: faithfulnessResult.costUsd + groundednessResult.costUsd + relevanceResult.costUsd,
  };
}

// ---------------------------------------------------------------------------
// Single-judge invocation
// ---------------------------------------------------------------------------

type JudgeResult =
  | { ok: true; score: MetricScore; costUsd: number }
  | { ok: false; errorCode?: string; errorMessage?: string; costUsd: number };

async function runJudge(
  judgeSlug: string,
  userMessage: string,
  userId: string
): Promise<JudgeResult> {
  try {
    const result = await drainStreamChat({
      agentSlug: judgeSlug,
      userId,
      message: userMessage,
      entityContext: { source: 'evaluation_judge', judgeAgentSlug: judgeSlug },
    });
    if (result.errorCode) {
      return {
        ok: false,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        costUsd: result.costUsd,
      };
    }
    const parsed = parseJudgeOutput(result.assistantText);
    if (!parsed) {
      logger.warn('scoreResponse: judge returned non-JSON', {
        judgeSlug,
        preview: result.assistantText.slice(0, 200),
      });
      return {
        ok: true,
        score: {
          score: null,
          reasoning: 'judge response was not valid {score, reasoning} JSON',
        },
        costUsd: result.costUsd,
      };
    }
    return { ok: true, score: parsed, costUsd: result.costUsd };
  } catch (err) {
    logger.warn('scoreResponse: judge call threw', {
      judgeSlug,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      costUsd: 0,
    };
  }
}

function nullScore(result: Extract<JudgeResult, { ok: false }>): MetricScore {
  return {
    score: null,
    reasoning: result.errorMessage
      ? `judge unavailable: ${result.errorMessage}`
      : `judge unavailable${result.errorCode ? ` (${result.errorCode})` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Prompt + response shaping
// ---------------------------------------------------------------------------

function buildJudgePrompt(params: ScoreResponseParams): string {
  const lines: string[] = [];
  lines.push(`QUESTION: ${params.userQuestion}`);
  lines.push('');
  lines.push(`ANSWER: ${params.aiResponse}`);
  if (params.citations.length > 0) {
    const trimmed = params.citations.slice(0, MAX_CITATIONS_IN_PROMPT).map((c) => ({
      marker: c.marker,
      documentName: c.documentName,
      section: c.section,
      excerpt: truncate(c.excerpt, MAX_EXCERPT_CHARS),
    }));
    lines.push('');
    lines.push(`CITED SOURCES: ${JSON.stringify(trimmed)}`);
  }
  return lines.join('\n');
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}…`;
}

function parseJudgeOutput(raw: string): MetricScore | null {
  return tryParseJson<MetricScore>(raw, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.reasoning !== 'string') return null;
    // evaluation_steps is the new v2 contract (snake-case on the wire,
    // camelCase in TS). Accept its absence so customised/legacy judges
    // parse cleanly.
    const stepsRaw = (obj as { evaluation_steps?: unknown }).evaluation_steps;
    const evaluationSteps = Array.isArray(stepsRaw)
      ? stepsRaw.filter((s): s is string => typeof s === 'string')
      : undefined;
    const base = (score: number | null): MetricScore =>
      evaluationSteps && evaluationSteps.length > 0
        ? { score, reasoning: obj.reasoning as string, evaluationSteps }
        : { score, reasoning: obj.reasoning as string };
    if (obj.score === null) return base(null);
    if (typeof obj.score !== 'number' || !Number.isFinite(obj.score)) return null;
    if (obj.score < 0 || obj.score > 1) return null;
    return base(obj.score);
  });
}
