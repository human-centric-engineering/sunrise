/**
 * Keyword Enricher — post-upload BM25 keyword generation.
 *
 * For every chunk of a document, run a small chat completion that
 * extracts 3–8 keyword phrases summarising the chunk. The result is
 * written to `AiKnowledgeChunk.keywords` as a comma-separated string;
 * Postgres regenerates the `searchVector` generated column automatically
 * (it does `to_tsvector('english', content || ' ' || keywords)`).
 *
 * Used by the admin "Enrich keywords" action — operators run it on docs
 * whose content vocabulary doesn't match the queries users actually ask.
 *
 * Concurrency: serial when the doc has ≤ `BATCH_THRESHOLD` chunks (to
 * keep cost predictable on small docs); batched ≤ `BATCH_SIZE` in
 * parallel above that. The provider's own rate limits still apply.
 *
 * Failures on individual chunks are caught and counted — the rest of
 * the doc still gets processed. The caller receives the count so the
 * UI can surface partial-success state.
 */

import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { CostOperation } from '@/types/orchestration';

/** Above this chunk count, enrich in parallel batches; below, run serially. */
const BATCH_THRESHOLD = 8;

/** Parallel-batch size when the doc is above the threshold. */
const BATCH_SIZE = 5;

/** Hard cap on chunks processed per call to bound cost and runtime. */
const MAX_CHUNKS_PER_RUN = 500;

const SYSTEM_PROMPT =
  'You extract concise BM25 search keywords from a single document chunk. ' +
  "Return 3 to 8 comma-separated keyword phrases that capture the chunk's " +
  'distinctive terminology. Rules: lowercase; hyphenate multi-word terms ' +
  '(e.g. "vector-search"); no full sentences; no punctuation beyond commas ' +
  'and hyphens; never invent terms not grounded in the chunk; if the chunk ' +
  'is boilerplate or content-free, return an empty string. Output only the ' +
  'comma-separated list — no preamble, no quotes, no JSON.';

const USER_PROMPT_TEMPLATE = (content: string): string =>
  `Chunk content:\n\n${content}\n\nKeywords:`;

export interface EnrichResult {
  chunksProcessed: number;
  chunksSkipped: number;
  chunksFailed: number;
  tokensUsed: number;
  costUsd: number;
  model: string;
}

export class NoChunksToEnrichError extends Error {
  constructor(documentId: string) {
    super(`Document ${documentId} has no chunks to enrich`);
    this.name = 'NoChunksToEnrichError';
  }
}

/**
 * Run keyword enrichment over every chunk in a document.
 *
 * Resolves the `chat` task model from `AiOrchestrationSettings`; operators
 * who want a cheaper model for this can adjust that slot. Each chunk
 * produces one LLM call; cost is logged per call via `logCost()` with
 * `operation: CHAT` and `metadata.purpose = 'knowledge.enrich_keywords'`
 * so the Costs admin can split this overhead from regular chat spend.
 */
export async function enrichDocumentKeywords(documentId: string): Promise<EnrichResult> {
  const modelId = await getDefaultModelForTask('chat');
  const modelInfo = getModel(modelId);
  if (!modelInfo) {
    throw new Error(`Resolved model "${modelId}" is not in the model registry`);
  }
  const provider = await getProvider(modelInfo.provider);

  const chunks = await prisma.aiKnowledgeChunk.findMany({
    where: { documentId },
    select: { id: true, content: true },
    orderBy: { chunkKey: 'asc' },
    take: MAX_CHUNKS_PER_RUN,
  });

  if (chunks.length === 0) {
    throw new NoChunksToEnrichError(documentId);
  }

  let chunksProcessed = 0;
  let chunksSkipped = 0;
  let chunksFailed = 0;
  let tokensUsed = 0;
  let costUsd = 0;

  const enrichOne = async (chunk: { id: string; content: string }): Promise<void> => {
    const content = chunk.content.trim();
    if (content.length === 0) {
      chunksSkipped += 1;
      return;
    }

    try {
      const response = await provider.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: USER_PROMPT_TEMPLATE(content) },
        ],
        {
          model: modelId,
          temperature: 0,
          maxTokens: 128,
        }
      );

      const keywords = normaliseKeywords(response.content);

      await prisma.aiKnowledgeChunk.update({
        where: { id: chunk.id },
        data: { keywords: keywords.length > 0 ? keywords : null },
      });

      const cost = calculateCost(modelId, response.usage.inputTokens, response.usage.outputTokens);
      tokensUsed += response.usage.inputTokens + response.usage.outputTokens;
      costUsd += cost.totalCostUsd;
      chunksProcessed += 1;

      void logCost({
        model: modelId,
        provider: modelInfo.provider,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        operation: CostOperation.KNOWLEDGE_ENRICH_KEYWORDS,
        isLocal: cost.isLocal,
        metadata: { documentId, chunkId: chunk.id },
      }).catch((err: unknown) => {
        logger.warn('enrichDocumentKeywords: logCost rejected', {
          documentId,
          chunkId: chunk.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      chunksFailed += 1;
      logger.warn('enrichDocumentKeywords: chunk failed', {
        documentId,
        chunkId: chunk.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (chunks.length <= BATCH_THRESHOLD) {
    for (const chunk of chunks) {
      await enrichOne(chunk);
    }
  } else {
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(enrichOne));
    }
  }

  logger.info('enrichDocumentKeywords completed', {
    documentId,
    model: modelId,
    chunksProcessed,
    chunksSkipped,
    chunksFailed,
    tokensUsed,
    costUsd,
  });

  return { chunksProcessed, chunksSkipped, chunksFailed, tokensUsed, costUsd, model: modelId };
}

/**
 * Sanitise model output into a comma-separated keyword list.
 *
 * Handles common drift: stray quotes, leading "Keywords:" preambles,
 * trailing punctuation, single-line newlines, surrounding markdown
 * fencing. Empty output (or all-whitespace) collapses to "".
 */
export function normaliseKeywords(raw: string): string {
  let s = raw.trim();
  if (s.length === 0) return '';

  // Strip code fences if the model returned ```...```
  if (s.startsWith('```')) {
    s = s
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  // Drop a leading "Keywords:" label if the model added one despite instructions.
  s = s.replace(/^keywords?\s*[:-]\s*/i, '').trim();

  // Replace newlines with commas so multi-line outputs collapse to a flat list.
  s = s.replace(/[\r\n]+/g, ',');

  const tokens = s
    .split(',')
    .map((t) =>
      t
        .trim()
        // Strip wrapping quotes/backticks the model may emit.
        .replace(/^["'`]+|["'`]+$/g, '')
        // Drop trailing punctuation that BM25 doesn't benefit from.
        .replace(/[.!?;]+$/g, '')
        .trim()
        .toLowerCase()
    )
    .filter((t) => t.length > 0 && t.length <= 80);

  // De-duplicate while preserving order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }

  return unique.join(', ');
}
