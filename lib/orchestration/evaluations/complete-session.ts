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

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { CostOperation } from '@/types/orchestration';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type {
  CompleteEvaluationParams,
  CompleteEvaluationResult,
} from '@/lib/orchestration/evaluations/types';

/** Maximum number of log events included in the analysis prompt. */
const MAX_LOGS_IN_PROMPT = 50;
/** Hard cap on the single LLM analysis call. */
const ANALYSIS_TIMEOUT_MS = 10_000;
const ANALYSIS_MAX_TOKENS = 1500;
const ANALYSIS_TEMPERATURE = 0.2;

const DEFAULT_PROVIDER = process.env.EVALUATION_DEFAULT_PROVIDER ?? 'anthropic';
const DEFAULT_MODEL = process.env.EVALUATION_DEFAULT_MODEL ?? 'claude-sonnet-4-6';

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

  if (session.status === 'completed') {
    throw new ConflictError('Evaluation session is already completed');
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
  };
  if (session.agentId) costParams.agentId = session.agentId;
  void logCost(costParams).catch((err) => {
    logger.error('Failed to log evaluation cost', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const updated = await prisma.aiEvaluationSession.update({
    where: { id: session.id },
    data: {
      status: 'completed',
      summary: analysis.summary,
      improvementSuggestions: analysis.improvementSuggestions,
      completedAt: new Date(),
    },
  });

  return {
    sessionId: updated.id,
    status: 'completed',
    summary: analysis.summary,
    improvementSuggestions: analysis.improvementSuggestions,
    tokenUsage: analysis.tokenUsage,
    costUsd: analysis.costUsd,
  };
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
  const signal = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);

  const first = await provider.chat(messages, {
    model,
    temperature: ANALYSIS_TEMPERATURE,
    maxTokens: ANALYSIS_MAX_TOKENS,
    signal,
  });

  const parsed = safeParseAnalysis(first.content);
  if (parsed) {
    const inputTokens = first.usage.inputTokens;
    const outputTokens = first.usage.outputTokens;
    return {
      summary: parsed.summary,
      improvementSuggestions: parsed.improvementSuggestions,
      tokenUsage: { input: inputTokens, output: outputTokens },
      costUsd: calculateCost(model, inputTokens, outputTokens).totalCostUsd,
    };
  }

  // Retry once with a stricter prompt. We do NOT include the malformed
  // prior response in the retry prompt (never trust model output as
  // part of a subsequent prompt when it just misbehaved).
  const retrySignal = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
  const retry = await provider.chat(
    [
      ...messages,
      {
        role: 'user',
        content:
          'Your previous response was not valid JSON. Respond ONLY with a JSON object of the form ' +
          '{"summary": "...", "improvementSuggestions": ["...", "..."]}. No prose, no code fences.',
      },
    ],
    {
      model,
      temperature: 0,
      maxTokens: ANALYSIS_MAX_TOKENS,
      signal: retrySignal,
    }
  );

  const reparsed = safeParseAnalysis(retry.content);
  if (!reparsed) {
    throw new Error('Analysis response was not valid JSON after retry');
  }

  const totalInputTokens = first.usage.inputTokens + retry.usage.inputTokens;
  const totalOutputTokens = first.usage.outputTokens + retry.usage.outputTokens;
  return {
    summary: reparsed.summary,
    improvementSuggestions: reparsed.improvementSuggestions,
    tokenUsage: {
      input: totalInputTokens,
      output: totalOutputTokens,
    },
    costUsd: calculateCost(model, totalInputTokens, totalOutputTokens).totalCostUsd,
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

function safeParseAnalysis(raw: string): EvaluationAnalysis | null {
  // The model may include surrounding whitespace or a stray code fence
  // even when asked not to. Try the raw string first, then strip common
  // wrappers.
  const candidates = [raw.trim(), stripCodeFence(raw.trim())];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
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
    } catch {
      // fall through
    }
  }
  return null;
}

function stripCodeFence(input: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const match = input.match(fence);
  return match ? match[1] : input;
}
