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
): Promise<number[][]> {
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
      const parsed = JSON.parse(errorText) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // use raw text as-is
    }
    throw new Error(`Embedding API error (${response.status}): ${message}`);
  }

  const embeddingResponseSchema = z.object({
    data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  });
  const result = embeddingResponseSchema.parse(await response.json());

  // Sort by index to maintain input order
  return result.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * Generate an embedding vector for a single text string.
 *
 * @param text - The text to embed
 * @returns Embedding vector (default 1536 dimensions)
 */
export async function embedText(text: string, inputType?: 'document' | 'query'): Promise<number[]> {
  const provider = await resolveProvider();

  logger.debug('Generating embedding', {
    model: provider.model,
    isLocal: provider.isLocal,
    textLength: text.length,
  });

  const results = await callEmbeddingApi(provider, text, inputType);
  return results[0];
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

    const embeddings = await callEmbeddingApi(provider, batch, inputType);
    if (embeddings.length !== batch.length) {
      throw new Error(
        `Embedding API returned ${embeddings.length} embeddings for ${batch.length} texts`
      );
    }
    allEmbeddings.push(...embeddings);

    // Rate limit between batches (skip for last batch)
    if (i + batchSize < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  logger.info('Batch embedding complete', {
    totalTexts: texts.length,
    totalEmbeddings: allEmbeddings.length,
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
