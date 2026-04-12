/**
 * `rag_retrieve` — knowledge-base retrieval.
 *
 * Config:
 *   - `query: string` — required; interpolated against the context.
 *   - `topK?: number` — default 5.
 *   - `similarityThreshold?: number` — default 0.7.
 *   - `filters?: SearchFilters`
 *
 * Output: `{ chunks: [{ content, similarity, ... }], count }`.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import type { ExecutionContext } from '../context';
import { ExecutorError } from '../errors';
import { interpolatePrompt } from '../llm-runner';
import { registerStepType } from '../executor-registry';

interface RagRetrieveConfig {
  query?: string;
  topK?: number;
  similarityThreshold?: number;
  filters?: Record<string, unknown>;
}

export async function executeRagRetrieve(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = step.config as RagRetrieveConfig;
  const rawQuery = config.query;
  if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
    throw new ExecutorError(step.id, 'missing_query', 'rag_retrieve step is missing a query');
  }

  const interpolated = interpolatePrompt(rawQuery, ctx);
  const topK = typeof config.topK === 'number' ? config.topK : 5;
  const threshold =
    typeof config.similarityThreshold === 'number' ? config.similarityThreshold : 0.7;

  let results;
  try {
    results = await searchKnowledge(
      interpolated,
      (config.filters as Parameters<typeof searchKnowledge>[1]) ?? undefined,
      topK,
      threshold
    );
  } catch (err) {
    throw new ExecutorError(
      step.id,
      'search_failed',
      err instanceof Error ? err.message : 'Knowledge search failed',
      err
    );
  }

  const chunks = results.map((r) => ({
    content: r.chunk.content,
    similarity: r.similarity,
    documentId: r.chunk.documentId,
    chunkType: r.chunk.chunkType,
  }));

  return {
    output: { chunks, count: chunks.length, query: interpolated },
    tokensUsed: 0,
    costUsd: 0,
  };
}

registerStepType('rag_retrieve', executeRagRetrieve);
