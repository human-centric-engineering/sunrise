/**
 * Text Embedding Service
 *
 * Generates vector embeddings for text using configured LLM providers.
 * Supports OpenAI-compatible APIs (OpenAI, Together, Ollama) with
 * automatic provider detection from AiProviderConfig.
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { calculateEmbeddingCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { CostOperation } from '@/types/orchestration';

/**
 * Static fallback embedding model. Only used when the
 * `AiOrchestrationSettings.defaultModels.embeddings` slot is empty
 * AND the registry's computed defaults can't supply one — typically
 * a fresh install before the wizard ran.
 */
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_BATCH_SIZE = 100;

/** Rate limit: pause between batches (ms) */
const BATCH_DELAY_MS = 200;

/** Provenance info returned alongside embedding vectors */
export interface EmbeddingProvenance {
  model: string;
  provider: string;
  embeddedAt: Date;
}

interface EmbeddingProvider {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  isLocal: boolean;
  providerType: string;
}

/**
 * Resolve the embedding provider from AiProviderConfig or fall back to defaults.
 *
 * Checks for an active provider with embedding support. For OpenAI,
 * uses the standard API. For Ollama and other OpenAI-compatible providers,
 * uses their /v1/embeddings endpoint.
 */
async function resolveProvider(): Promise<EmbeddingProvider> {
  // Check for configured providers that support embeddings
  const providers = await prisma.aiProviderConfig.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  // Resolve the operator-configured embedding model. Voyage and Ollama
  // ignore this — they have their own canonical embedding models — but
  // every other openai-compatible host honours it.
  const settingsModel = await getDefaultModelForTask('embeddings').catch(() => DEFAULT_MODEL);

  // Prefer Voyage AI provider (best retrieval quality, free tier)
  const voyageProvider = providers.find((p) => p.providerType === 'voyage');
  if (voyageProvider) {
    const apiKey = voyageProvider.apiKeyEnvVar
      ? (process.env[voyageProvider.apiKeyEnvVar] ?? null)
      : null;
    return {
      baseUrl: voyageProvider.baseUrl ?? 'https://api.voyageai.com/v1',
      apiKey,
      model: 'voyage-3',
      isLocal: false,
      providerType: 'voyage',
    };
  }

  // Prefer a local provider for embeddings (cheaper/faster)
  const localProvider = providers.find((p) => p.isLocal);
  if (localProvider?.baseUrl) {
    return {
      baseUrl: localProvider.baseUrl,
      apiKey: localProvider.apiKeyEnvVar ? (process.env[localProvider.apiKeyEnvVar] ?? null) : null,
      model: 'nomic-embed-text',
      isLocal: true,
      providerType: localProvider.providerType,
    };
  }

  // Fall back to OpenAI-compatible provider
  const openaiCompatible = providers.find(
    (p) => p.providerType === 'openai-compatible' && p.baseUrl
  );
  if (openaiCompatible?.baseUrl) {
    const apiKey = openaiCompatible.apiKeyEnvVar
      ? (process.env[openaiCompatible.apiKeyEnvVar] ?? null)
      : null;
    return {
      baseUrl: openaiCompatible.baseUrl,
      apiKey,
      model: settingsModel || DEFAULT_MODEL,
      isLocal: false,
      providerType: 'openai-compatible',
    };
  }

  // Default: OpenAI API directly
  const openaiKey = process.env['OPENAI_API_KEY'] ?? null;
  if (!openaiKey) {
    throw new Error(
      'No embedding provider configured. Set the OPENAI_API_KEY environment variable ' +
        'or configure an embedding provider in the admin settings.'
    );
  }
  return {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: openaiKey,
    model: settingsModel || DEFAULT_MODEL,
    isLocal: false,
    providerType: 'openai-compatible',
  };
}

/**
 * Call an OpenAI-compatible embeddings endpoint.
 */
async function callEmbeddingApi(
  provider: EmbeddingProvider,
  input: string | string[],
  inputType?: 'document' | 'query'
): Promise<{ embeddings: number[][]; inputTokens: number }> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    input,
  };

  // Voyage-specific parameters: input_type and output_dimension
  if (provider.providerType === 'voyage') {
    body['input_type'] = inputType ?? 'document';
    body['output_dimension'] = DEFAULT_DIMENSIONS;
  }

  // Request specific dimensions for OpenAI models that support it
  if (provider.providerType !== 'voyage' && provider.model === DEFAULT_MODEL && !provider.isLocal) {
    body['dimensions'] = DEFAULT_DIMENSIONS;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText;
    try {
      // The embedding provider's error envelope isn't part of our
      // contract — different vendors shape it differently. Validate
      // structurally with Zod so a malformed JSON or unexpected shape
      // falls back to the raw text rather than throwing in the parse
      // branch.
      const errorResponseSchema = z.object({
        error: z.object({ message: z.string().optional() }).partial().optional(),
      });
      const parsed = errorResponseSchema.safeParse(JSON.parse(errorText));
      if (parsed.success && parsed.data.error?.message) {
        message = parsed.data.error.message;
      }
    } catch {
      // JSON.parse threw — vendor returned non-JSON. Use raw text as-is.
    }
    throw new Error(`Embedding API error (${response.status}): ${message}`);
  }

  const embeddingResponseSchema = z.object({
    data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
    // `usage.prompt_tokens` is reported by OpenAI / Voyage; Ollama and
    // some self-hosted providers omit it. Parse defensively so the
    // happy path doesn't fail when usage is absent.
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .optional(),
  });
  const result = embeddingResponseSchema.parse(await response.json());

  const inputTokens =
    result.usage?.prompt_tokens ?? result.usage?.total_tokens ?? estimateEmbeddingTokens(input);

  return {
    embeddings: result.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
    inputTokens,
  };
}

/**
 * Heuristic fallback for providers that don't return `usage` (Ollama,
 * some OpenAI-compatible local servers). ~4 chars/token matches the
 * o200k_base / cl100k_base density for English prose closely enough
 * for billing-volume tracking; under-counting here would *under-bill*
 * embeddings, so we round up to be safe.
 */
function estimateEmbeddingTokens(input: string | string[]): number {
  const texts = Array.isArray(input) ? input : [input];
  let chars = 0;
  for (const t of texts) chars += t.length;
  return Math.ceil(chars / 4);
}

/**
 * Result of a single-text embedding call. Carries the vector plus the
 * provenance and billing data so callers (chat handler, MCP server, …)
 * can attribute the call to a turn / request without re-resolving the
 * provider config.
 */
export interface EmbedTextResult {
  embedding: number[];
  model: string;
  provider: string;
  /** Input tokens billed for this call, as reported by the provider (or estimated). */
  inputTokens: number;
  /** Local-provider calls cost $0; rate-table misses also produce 0. */
  costUsd: number;
}

/**
 * Generate an embedding vector for a single text string.
 *
 * Writes an `AiCostLog` row (best-effort, fire-and-forget) so embeddings
 * count toward the global / per-agent spend totals the same way chat
 * completions do. Failure to log never propagates to the caller — the
 * embedding vector is the contract.
 *
 * @param text - The text to embed
 * @returns Embedding vector plus the provider/model/cost provenance.
 */
export async function embedText(
  text: string,
  inputType?: 'document' | 'query'
): Promise<EmbedTextResult> {
  const provider = await resolveProvider();

  logger.debug('Generating embedding', {
    model: provider.model,
    isLocal: provider.isLocal,
    textLength: text.length,
  });

  const { embeddings, inputTokens } = await callEmbeddingApi(provider, text, inputType);
  const cost = calculateEmbeddingCost(provider.model, inputTokens);

  // Best-effort cost log. Embeddings should never fail a caller because
  // of an accounting write.
  void logCost({
    model: provider.model,
    provider: provider.providerType,
    inputTokens,
    outputTokens: 0,
    operation: CostOperation.EMBEDDING,
    isLocal: provider.isLocal || cost.isLocal,
  });

  return {
    embedding: embeddings[0],
    model: provider.model,
    provider: provider.providerType,
    inputTokens,
    costUsd: cost.totalCostUsd,
  };
}

/** Result of a batch embedding operation */
export interface EmbedBatchResult {
  embeddings: number[][];
  provenance: EmbeddingProvenance;
}

/**
 * Generate embeddings for multiple texts with batching and rate limiting.
 *
 * @param texts - Array of texts to embed
 * @param batchSize - Number of texts per API call (default 100)
 * @returns Embedding vectors and provenance metadata
 */
export async function embedBatch(
  texts: string[],
  batchSize: number = DEFAULT_BATCH_SIZE,
  inputType?: 'document' | 'query'
): Promise<EmbedBatchResult> {
  const provider = await resolveProvider();
  const allEmbeddings: number[][] = [];
  let totalInputTokens = 0;

  logger.info('Starting batch embedding', {
    totalTexts: texts.length,
    batchSize,
    model: provider.model,
    isLocal: provider.isLocal,
  });

  const embeddedAt = new Date();

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(texts.length / batchSize);

    logger.debug('Processing embedding batch', {
      batch: batchNum,
      totalBatches,
      batchSize: batch.length,
    });

    const { embeddings, inputTokens } = await callEmbeddingApi(provider, batch, inputType);
    if (embeddings.length !== batch.length) {
      throw new Error(
        `Embedding API returned ${embeddings.length} embeddings for ${batch.length} texts`
      );
    }
    allEmbeddings.push(...embeddings);
    totalInputTokens += inputTokens;

    // Rate limit between batches (skip for last batch)
    if (i + batchSize < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  logger.info('Batch embedding complete', {
    totalTexts: texts.length,
    totalEmbeddings: allEmbeddings.length,
    totalInputTokens,
  });

  // Best-effort: one cost row for the whole batch. Document-ingestion
  // batches typically run from the admin UI rather than per-turn, so a
  // rolled-up row keeps `AiCostLog` from exploding on bulk imports.
  const cost = calculateEmbeddingCost(provider.model, totalInputTokens);
  void logCost({
    model: provider.model,
    provider: provider.providerType,
    inputTokens: totalInputTokens,
    outputTokens: 0,
    operation: CostOperation.EMBEDDING,
    isLocal: provider.isLocal || cost.isLocal,
  });

  return {
    embeddings: allEmbeddings,
    provenance: {
      model: provider.model,
      provider: provider.providerType,
      embeddedAt,
    },
  };
}
