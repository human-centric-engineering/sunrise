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
import { ragRetrieveConfigSchema } from '@/lib/validations/orchestration';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

export async function executeRagRetrieve(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = ragRetrieveConfigSchema.parse(step.config);
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
    // The query embedding is real spend on the execution's behalf. Carrier
    // metadata first, `stepId` last — same precedence rule as every other cost
    // sink in the engine (#600), and `stepId` is what both execution cost
    // readers filter on.
    results = await searchKnowledge(interpolated, config.filters ?? undefined, topK, threshold, {
      workflowExecutionId: ctx.executionId,
      metadata: { ...(ctx.costLogMetadata ?? {}), stepId: step.id, kind: 'rag_retrieve' },
    });
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
