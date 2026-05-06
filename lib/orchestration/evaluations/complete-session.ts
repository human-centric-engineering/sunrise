/**
 * Complete Evaluation Session
 *
 * Generates an AI-written summary + improvement suggestions for an
 * evaluation session using the agent's own provider/model, flips the
 * session to `completed`, and logs a `CostOperation.EVALUATION` cost
 * row for the analysis call.
 *
 * Contract:
 *  - Ownership is enforced by the caller via `{ id, userId }`. A missing
 *    session (either non-existent or cross-user) throws `NotFoundError`.
 *  - Sessions already `status === 'completed'` throw `ConflictError`
 *    (no double-billing, no overwriting a prior analysis).
 *  - Sessions with zero logs throw `ValidationError` — there is nothing
 *    to analyse.
 *  - If the session's agent has been deleted (`session.agentId === null`),
 *    we fall back to the provider slug in `EVALUATION_DEFAULT_PROVIDER`
 *    (defaults to `'anthropic'`) with the model in
 *    `EVALUATION_DEFAULT_MODEL` (defaults to `'claude-sonnet-4-6'`).
 *  - Raw LLM output is never forwarded in error messages. If the model
 *    returns malformed JSON we retry once with a stricter prompt; on
 *    the second failure we throw a typed error with a sanitized message.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { Prisma } from '@/types/prisma';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { CostOperation, type Citation } from '@/types/orchestration';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type {
  CompleteEvaluationParams,
  CompleteEvaluationResult,
  EvaluationMetricSummary,
  RescoreEvaluationParams,
  RescoreEvaluationResult,
} from '@/lib/orchestration/evaluations/types';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';
import { scoreResponse } from '@/lib/orchestration/evaluations/score-response';

/** Maximum number of log events included in the analysis prompt. */
const MAX_LOGS_IN_PROMPT = 50;
/** Hard cap on the single LLM analysis call. */
const ANALYSIS_TIMEOUT_MS = 10_000;
const ANALYSIS_MAX_TOKENS = 1500;
const ANALYSIS_TEMPERATURE = 0.2;

const DEFAULT_PROVIDER = process.env.EVALUATION_DEFAULT_PROVIDER ?? 'anthropic';
const DEFAULT_MODEL = process.env.EVALUATION_DEFAULT_MODEL ?? 'claude-sonnet-4-6';

/**
 * Judge model used for the per-turn metric scorer (faithfulness,
 * groundedness, relevance). Independent of the agent under test so a
 * Haiku-powered agent can be judged by a stronger model. Falls through
 * to `EVALUATION_DEFAULT_PROVIDER` / `EVALUATION_DEFAULT_MODEL` when
 * the dedicated env vars aren't set.
 */
const JUDGE_PROVIDER = process.env.EVALUATION_JUDGE_PROVIDER ?? DEFAULT_PROVIDER;
const JUDGE_MODEL = process.env.EVALUATION_JUDGE_MODEL ?? DEFAULT_MODEL;

interface EvaluationAnalysis {
  summary: string;
  improvementSuggestions: string[];
}

export async function completeEvaluationSession(
  params: CompleteEvaluationParams
): Promise<CompleteEvaluationResult> {
  const session = await prisma.aiEvaluationSession.findFirst({
    where: { id: params.sessionId, userId: params.userId },
    include: {
      agent: { select: { id: true, name: true, slug: true, provider: true, model: true } },
    },
  });

  if (!session) {
    // Cross-user access returns 404 (not 403) to avoid confirming existence.
    throw new NotFoundError('Evaluation session not found');
  }

  if (session.status === 'completed' || session.status === 'archived') {
    throw new ConflictError(
      session.status === 'completed'
        ? 'Evaluation session is already completed'
        : 'Cannot complete an archived evaluation session'
    );
  }

  const logs = await prisma.aiEvaluationLog.findMany({
    where: { sessionId: session.id },
    orderBy: { sequenceNumber: 'asc' },
    take: MAX_LOGS_IN_PROMPT,
  });

  if (logs.length === 0) {
    throw new ValidationError('Evaluation session has no logs to analyse');
  }

  // Agent may have been deleted while the session was in progress —
  // fall back to the default provider/model so completion still works.
  const providerSlug = session.agent?.provider ?? DEFAULT_PROVIDER;
  const model = session.agent?.model ?? DEFAULT_MODEL;

  const provider = await getProvider(providerSlug);

  const messages = buildAnalysisMessages({
    sessionTitle: session.title,
    sessionDescription: session.description,
    logs,
  });

  let analysis: AnalysisResult;
  try {
    analysis = await runAnalysis(provider, messages, model);
  } catch (err) {
    logger.error('Evaluation analysis failed', {
      sessionId: session.id,
      agentId: session.agentId,
      providerSlug,
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    // Never forward raw LLM / provider SDK error text.
    throw new Error('Failed to generate evaluation analysis');
  }

  // Fire-and-forget cost logging — a Prisma write failure here must
  // not abort the completion path.
  const costParams: Parameters<typeof logCost>[0] = {
    model,
    provider: providerSlug,
    inputTokens: analysis.tokenUsage.input,
    outputTokens: analysis.tokenUsage.output,
    operation: CostOperation.EVALUATION,
    metadata: { phase: 'summary' },
  };
  if (session.agentId) costParams.agentId = session.agentId;
  void logCost(costParams).catch((err) => {
    logger.error('Failed to log evaluation cost', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Score per-turn metrics. Wrap so a wholesale scoring failure still
  // lets the session complete with the summary; partial successes are
  // already persisted per-log inside scoreEvaluationLogs.
  let metricSummary: EvaluationMetricSummary | null = null;
  try {
    metricSummary = await scoreEvaluationLogs({
      sessionId: session.id,
      logs,
      agentId: session.agentId,
      previousScoringCostUsd: 0,
    });
  } catch (err) {
    logger.error('Evaluation metric scoring failed wholesale (completion continues)', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const metricSummaryJson: Prisma.InputJsonValue | undefined = metricSummary
    ? (metricSummary as unknown as Prisma.InputJsonValue)
    : undefined;
  const updated = await prisma.aiEvaluationSession.update({
    where: { id: session.id },
    data: {
      status: 'completed',
      summary: analysis.summary,
      improvementSuggestions: analysis.improvementSuggestions,
      completedAt: new Date(),
      ...(metricSummaryJson !== undefined ? { metricSummary: metricSummaryJson } : {}),
    },
  });

  return {
    sessionId: updated.id,
    status: 'completed',
    summary: analysis.summary,
    improvementSuggestions: analysis.improvementSuggestions,
    tokenUsage: analysis.tokenUsage,
    costUsd: analysis.costUsd,
    metricSummary,
  };
}

/**
 * Re-run the metric scorer for an already-completed evaluation session.
 * Overwrites scores in place, refreshes `metricSummary.scoredAt`, and
 * accumulates `totalScoringCostUsd` across runs. Useful after a
 * knowledge-base update, prompt tweak, or model swap.
 */
export async function rescoreEvaluationSession(
  params: RescoreEvaluationParams
): Promise<RescoreEvaluationResult> {
  const session = await prisma.aiEvaluationSession.findFirst({
    where: { id: params.sessionId, userId: params.userId },
    select: {
      id: true,
      status: true,
      agentId: true,
      metricSummary: true,
    },
  });

  if (!session) throw new NotFoundError('Evaluation session not found');
  if (session.status !== 'completed') {
    throw new ConflictError('Only completed evaluation sessions can be re-scored');
  }

  const logs = await prisma.aiEvaluationLog.findMany({
    where: { sessionId: session.id },
    orderBy: { sequenceNumber: 'asc' },
    take: MAX_LOGS_IN_PROMPT,
  });
  if (logs.length === 0) {
    throw new ValidationError('Evaluation session has no logs to score');
  }

  const previous = session.metricSummary as EvaluationMetricSummary | null;
  const previousCost = previous?.totalScoringCostUsd ?? 0;

  const metricSummary = await scoreEvaluationLogs({
    sessionId: session.id,
    logs,
    agentId: session.agentId,
    previousScoringCostUsd: previousCost,
  });

  await prisma.aiEvaluationSession.update({
    where: { id: session.id },
    data: { metricSummary: metricSummary as unknown as Prisma.InputJsonValue },
  });

  return { sessionId: session.id, metricSummary };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AnalysisResult extends EvaluationAnalysis {
  tokenUsage: { input: number; output: number };
  costUsd: number;
}

async function runAnalysis(
  provider: Awaited<ReturnType<typeof getProvider>>,
  messages: LlmMessage[],
  model: string
): Promise<AnalysisResult> {
  const result = await runStructuredCompletion<EvaluationAnalysis>({
    provider,
    model,
    messages,
    parse: parseAnalysis,
    retryUserMessage:
      'Your previous response was not valid JSON. Respond ONLY with a JSON object of the form ' +
      '{"summary": "...", "improvementSuggestions": ["...", "..."]}. No prose, no code fences.',
    temperature: ANALYSIS_TEMPERATURE,
    maxTokens: ANALYSIS_MAX_TOKENS,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    onFinalFailure: () => new Error('Analysis response was not valid JSON after retry'),
    phase: 'summary',
  });
  return {
    summary: result.value.summary,
    improvementSuggestions: result.value.improvementSuggestions,
    tokenUsage: result.tokenUsage,
    costUsd: result.costUsd,
  };
}

interface BuildMessagesOptions {
  sessionTitle: string;
  sessionDescription: string | null;
  logs: Array<{
    sequenceNumber: number;
    eventType: string;
    content: string | null;
    capabilitySlug: string | null;
  }>;
}

function buildAnalysisMessages(opts: BuildMessagesOptions): LlmMessage[] {
  const transcript = opts.logs
    .map((log) => {
      const prefix = `#${log.sequenceNumber} [${log.eventType}]`;
      const body =
        log.eventType === 'capability_call' || log.eventType === 'capability_result'
          ? `${log.capabilitySlug ?? 'unknown'}: ${truncate(log.content ?? '', 500)}`
          : truncate(log.content ?? '', 500);
      return `${prefix} ${body}`;
    })
    .join('\n');

  const systemContent = [
    'You are an evaluation analyst reviewing a transcript between a user and an AI agent.',
    'Analyse the transcript and produce a concise performance summary plus actionable improvement suggestions.',
    'Respond ONLY with a JSON object of the form {"summary": "...", "improvementSuggestions": ["...", "..."]}.',
    'Do not wrap the JSON in code fences. Do not include any prose outside the JSON.',
  ].join(' ');

  const userContent = [
    `Evaluation title: ${opts.sessionTitle}`,
    opts.sessionDescription ? `Description: ${opts.sessionDescription}` : null,
    '',
    'Transcript:',
    transcript,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}

function parseAnalysis(raw: string): EvaluationAnalysis | null {
  return tryParseJson<EvaluationAnalysis>(raw, (parsed) => {
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { summary?: unknown }).summary === 'string' &&
      Array.isArray((parsed as { improvementSuggestions?: unknown }).improvementSuggestions) &&
      (parsed as { improvementSuggestions: unknown[] }).improvementSuggestions.every(
        (s) => typeof s === 'string'
      )
    ) {
      const obj = parsed as EvaluationAnalysis;
      return { summary: obj.summary, improvementSuggestions: obj.improvementSuggestions };
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Per-turn metric scoring (named-metrics work)
// ---------------------------------------------------------------------------

interface ScoreLogsOptions {
  sessionId: string;
  logs: Array<{
    id: string;
    sequenceNumber: number;
    eventType: string;
    content: string | null;
    metadata: unknown;
  }>;
  agentId: string | null;
  /** USD already spent on prior scoring runs for this session — added to the new run's spend on rescore. */
  previousScoringCostUsd: number;
}

/**
 * Walk the log array, score every `ai_response` log against the immediately
 * prior `user_input` log, persist scores per log, and return the aggregate
 * summary. Per-log judge errors are swallowed (logged at warn level) so a
 * single bad turn doesn't void the whole pass.
 */
async function scoreEvaluationLogs(opts: ScoreLogsOptions): Promise<EvaluationMetricSummary> {
  const judgeProvider = await getProvider(JUDGE_PROVIDER);

  const faithfulnessScores: number[] = [];
  const groundednessScores: number[] = [];
  const relevanceScores: number[] = [];
  let scoredCount = 0;
  let totalRunCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  let lastUserContent: string | null = null;
  for (const log of opts.logs) {
    if (log.eventType === 'user_input') {
      lastUserContent = log.content;
      continue;
    }
    if (log.eventType !== 'ai_response') continue;
    if (!lastUserContent) continue; // ai_response without a preceding question — skip.

    const citations = extractLogCitations(log.metadata);
    try {
      const result = await scoreResponse({
        userQuestion: lastUserContent,
        aiResponse: log.content ?? '',
        citations,
        judgeProvider,
        judgeModel: JUDGE_MODEL,
      });
      const { faithfulness, groundedness, relevance } = result.scores;

      const judgeReasoning: Prisma.InputJsonValue = {
        faithfulness: { reasoning: faithfulness.reasoning },
        groundedness: { reasoning: groundedness.reasoning },
        relevance: { reasoning: relevance.reasoning },
      };
      await prisma.aiEvaluationLog.update({
        where: { id: log.id },
        data: {
          faithfulnessScore: faithfulness.score,
          groundednessScore: groundedness.score,
          relevanceScore: relevance.score,
          judgeReasoning,
        },
      });

      if (faithfulness.score !== null) faithfulnessScores.push(faithfulness.score);
      if (groundedness.score !== null) groundednessScores.push(groundedness.score);
      if (relevance.score !== null) relevanceScores.push(relevance.score);
      scoredCount++;
      totalRunCostUsd += result.costUsd;
      totalInputTokens += result.tokenUsage.input;
      totalOutputTokens += result.tokenUsage.output;
    } catch (err) {
      logger.warn('Per-turn metric scoring failed (run continues)', {
        sessionId: opts.sessionId,
        logId: log.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Aggregate cost into a single AiCostLog row tagged phase=scoring so
  // analytics can split summary spend from scoring spend without a new
  // CostOperation enum value.
  if (scoredCount > 0) {
    const costParams: Parameters<typeof logCost>[0] = {
      model: JUDGE_MODEL,
      provider: JUDGE_PROVIDER,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      operation: CostOperation.EVALUATION,
      metadata: { phase: 'scoring', logsScored: scoredCount },
    };
    if (opts.agentId) costParams.agentId = opts.agentId;
    void logCost(costParams).catch((err) => {
      logger.error('Failed to log evaluation scoring cost', {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    avgFaithfulness: average(faithfulnessScores),
    avgGroundedness: average(groundednessScores),
    avgRelevance: average(relevanceScores),
    scoredLogCount: scoredCount,
    judgeProvider: JUDGE_PROVIDER,
    judgeModel: JUDGE_MODEL,
    scoredAt: new Date().toISOString(),
    totalScoringCostUsd: opts.previousScoringCostUsd + totalRunCostUsd,
  };
}

/**
 * Read citations from an `AiEvaluationLog.metadata` JSON blob and filter
 * out anything that doesn't match the `Citation` shape needed by the
 * judge prompt builder (`marker`, `excerpt`, plus the strings/nulls the
 * prompt renders). Defensive against future schema drift, hand-edited
 * rows, and partial writes — without this, a single malformed entry
 * would throw `undefined.length` inside `truncate(c.excerpt, ...)`.
 */
function extractLogCitations(metadata: unknown): Citation[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const citations = (metadata as { citations?: unknown }).citations;
  if (!Array.isArray(citations)) return [];
  return citations.filter(isValidCitation);
}

function isValidCitation(value: unknown): value is Citation {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.marker === 'number' &&
    typeof c.chunkId === 'string' &&
    typeof c.documentId === 'string' &&
    typeof c.excerpt === 'string' &&
    typeof c.similarity === 'number' &&
    (c.documentName === null || typeof c.documentName === 'string') &&
    (c.section === null || typeof c.section === 'string')
  );
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
