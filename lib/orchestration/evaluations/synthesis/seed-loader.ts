/**
 * Synthesis seed loader.
 *
 * Pure data-loading layer for the case generator. Two modes:
 *
 *   - **KB seed** — pull a representative sample of knowledge chunks
 *     the subject agent has access to. Goal: give the generator real
 *     material to write grounded cases against. We do NOT do a
 *     similarity search here — the generator should see breadth
 *     across the agent's docs, not depth on one query.
 *
 *   - **Failure seed** — pull low-scoring prior `AiEvaluationCaseResult`
 *     rows for the subject agent, joined to their source `AiDatasetCase`
 *     so the generator can see the (input, expectedOutput) pair plus
 *     the score and (truncated) judge reasoning. Lets the generator
 *     write "similar but harder" variants targeting the same failure
 *     mode.
 *
 * Caller responsibilities:
 *   - Ownership: pass `agentId` you've authenticated against the caller.
 *   - Limits: the route enforces upstream `count` caps; this layer just
 *     returns whatever the DB has (capped to a sensible max each side).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveAgentDocumentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';

const MAX_KB_CHUNKS = 12;
const MAX_KB_CHUNK_CHARS = 800;
const MAX_FAILURE_SEEDS = 8;
const MAX_FAILURE_INPUT_CHARS = 400;
const MAX_FAILURE_OUTPUT_CHARS = 400;
const MAX_FAILURE_REASONING_CHARS = 300;
/**
 * Score threshold below which a case is considered a "failure" worth
 * synthesising harder variants of. The judge contract is `score ∈ [0, 1]`
 * with higher = better; 0.6 is a deliberately loose floor so the seed
 * set isn't dominated by edge cases.
 */
const FAILURE_SCORE_THRESHOLD = 0.6;

export interface KbSeedChunk {
  documentId: string;
  documentName: string | null;
  chunkType: string;
  /** Truncated content suitable for inclusion in the generator prompt. */
  content: string;
}

export interface FailureSeed {
  caseId: string;
  /** Truncated to keep prompts manageable. */
  input: string;
  expectedOutput: string | null;
  /** Median grader score across the case's metric_scores. */
  score: number;
  /** Truncated reasoning from the worst-scoring grader, if available. */
  reasoning: string | null;
}

/**
 * Load up to N representative chunks from the subject agent's
 * accessible documents. Order is randomised at the DB layer so the
 * generator sees a different slice on each invocation, encouraging
 * diversity across repeated synthesis calls.
 */
export async function loadKbSeed(params: {
  agentId: string;
  topic?: string;
  limit?: number;
}): Promise<KbSeedChunk[]> {
  const limit = Math.min(params.limit ?? MAX_KB_CHUNKS, MAX_KB_CHUNKS);
  const access = await resolveAgentDocumentAccess(params.agentId);

  try {
    // Restricted mode: filter to granted docs (+ system-scope if flagged).
    // Full-access mode: no document filter.
    const where: Record<string, unknown> = {};
    if (access.mode === 'restricted') {
      const allowedDocIds = await loadAllowedDocIds(access.documentIds, access.includeSystemScope);
      if (allowedDocIds.length === 0) return [];
      where.documentId = { in: allowedDocIds };
    }

    const chunks = await prisma.aiKnowledgeChunk.findMany({
      where,
      take: limit,
      // Topic-anchored is not relevance-ranked here — we want breadth.
      // The generator agent is responsible for picking question angles.
      // A future iteration could fan out to `searchKnowledge` when
      // `topic` is set, but plain order suits the breadth goal today.
      orderBy: { id: 'asc' },
      select: {
        documentId: true,
        content: true,
        chunkType: true,
        document: { select: { name: true } },
      },
    });

    return chunks.map((c) => ({
      documentId: c.documentId,
      documentName: c.document?.name ?? null,
      chunkType: c.chunkType,
      content: truncate(c.content, MAX_KB_CHUNK_CHARS),
    }));
  } catch (err) {
    logger.warn('loadKbSeed: query failed, returning empty seed', {
      agentId: params.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function loadAllowedDocIds(
  granted: string[],
  includeSystemScope: boolean
): Promise<string[]> {
  if (!includeSystemScope) return granted;
  try {
    const systemDocs = await prisma.aiKnowledgeDocument.findMany({
      where: { scope: 'system' },
      select: { id: true },
    });
    return Array.from(new Set([...granted, ...systemDocs.map((d) => d.id)]));
  } catch {
    return granted;
  }
}

/**
 * Load up to N low-scoring case results for the subject agent. We
 * select rows whose mean metric score is below the failure threshold
 * (defaulting to 0.6); the worst-scoring grader's reasoning is
 * surfaced so the generator can see *why* the case failed.
 */
export async function loadFailureSeed(params: {
  agentId: string;
  /**
   * Caller's user id. Agents are shared across admins but
   * `AiEvaluationRun.userId` is the ownership column — without this
   * filter the failure seed would pull other admins' prior runs
   * (and their case content) into this caller's generator prompt.
   */
  userId: string;
  limit?: number;
}): Promise<FailureSeed[]> {
  const limit = Math.min(params.limit ?? MAX_FAILURE_SEEDS, MAX_FAILURE_SEEDS);

  try {
    // Pull recent completed runs for this agent (subject runs only) and
    // their case results. Bound the join to ~recent runs so we don't
    // scan every historical row. The case-level mean score has to be
    // computed in JS because metricScores is JSON.
    //
    // userId is part of the where clause — see the param doc above for
    // the cross-user leak this prevents.
    const recentRuns = await prisma.aiEvaluationRun.findMany({
      where: {
        agentId: params.agentId,
        userId: params.userId,
        subjectKind: 'agent',
        status: 'completed',
      },
      select: { id: true },
      orderBy: { completedAt: 'desc' },
      take: 10,
    });
    if (recentRuns.length === 0) return [];

    const candidates = await prisma.aiEvaluationCaseResult.findMany({
      where: { runId: { in: recentRuns.map((r) => r.id) } },
      select: {
        datasetCaseId: true,
        metricScores: true,
        datasetCase: {
          select: { input: true, expectedOutput: true },
        },
      },
      take: 200, // cap fetch breadth; we'll filter to N failures below
      orderBy: { id: 'desc' },
    });

    const failures: FailureSeed[] = [];
    const seenCaseIds = new Set<string>();
    for (const row of candidates) {
      if (seenCaseIds.has(row.datasetCaseId)) continue;
      const { meanScore, worstReasoning } = readScoreSummary(row.metricScores);
      if (meanScore === null || meanScore >= FAILURE_SCORE_THRESHOLD) continue;

      seenCaseIds.add(row.datasetCaseId);
      failures.push({
        caseId: row.datasetCaseId,
        input: truncate(stringifyInput(row.datasetCase.input), MAX_FAILURE_INPUT_CHARS),
        expectedOutput: row.datasetCase.expectedOutput
          ? truncate(row.datasetCase.expectedOutput, MAX_FAILURE_OUTPUT_CHARS)
          : null,
        score: meanScore,
        reasoning: worstReasoning ? truncate(worstReasoning, MAX_FAILURE_REASONING_CHARS) : null,
      });
      if (failures.length >= limit) break;
    }
    return failures;
  } catch (err) {
    logger.warn('loadFailureSeed: query failed, returning empty seed', {
      agentId: params.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function readScoreSummary(metricScores: unknown): {
  meanScore: number | null;
  worstReasoning: string | null;
} {
  if (!metricScores || typeof metricScores !== 'object' || Array.isArray(metricScores)) {
    return { meanScore: null, worstReasoning: null };
  }
  const scores: number[] = [];
  let worstScore = Number.POSITIVE_INFINITY;
  let worstReasoning: string | null = null;
  for (const value of Object.values(metricScores as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as { score?: unknown; reasoning?: unknown };
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score)) continue;
    scores.push(entry.score);
    if (entry.score < worstScore) {
      worstScore = entry.score;
      worstReasoning = typeof entry.reasoning === 'string' ? entry.reasoning : null;
    }
  }
  if (scores.length === 0) return { meanScore: null, worstReasoning: null };
  const meanScore = scores.reduce((s, x) => s + x, 0) / scores.length;
  return { meanScore, worstReasoning };
}

function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return '';
  return JSON.stringify(input);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
