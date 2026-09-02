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
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { describeFetchFailure } from '@/lib/errors/fetch-error';

/**
 * Static fallback embedding model. Only used when neither
 * `AiOrchestrationSettings.activeEmbeddingModelId` is set nor the
 * legacy `defaultModels.embeddings` slot has a value — typically a
 * fresh install before the wizard ran.
 */
const DEFAULT_MODEL = 'text-embedding-3-small';
const FALLBACK_DIMENSIONS = 1536;
const DEFAULT_BATCH_SIZE = 100;

/** Rate limit: pause between batches (ms) */
const BATCH_DELAY_MS = 200;

/**
 * Provenance info returned alongside embedding vectors. `dimensions` is
 * persisted to `AiKnowledgeChunk.embeddingDimension` /
 * `AiMessageEmbedding.embeddingDimension` so search-time validation
 * (Phase 4) can detect drift between the stored vectors and the
 * currently-active model.
 */
export interface EmbeddingProvenance {
  model: string;
  provider: string;
  dimensions: number;
  embeddedAt: Date;
}

interface EmbeddingProvider {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Output dimension of `model`. Recorded as provenance and (if `schemaCompatible`) requested via the `dimensions` API parameter. */
  dimensions: number;
  /**
   * True when `model` accepts the OpenAI-style `dimensions` parameter
   * (text-embedding-3-*, voyage-3, …) and so can be coerced to a non-
   * native dim. False for fixed-dim models like nomic-embed-text. Drives
   * whether `callEmbeddingApi` sends `dimensions` to non-Voyage hosts.
   */
  schemaCompatible: boolean;
  isLocal: boolean;
  providerType: string;
}

/**
 * Cheap read of just the active embedding model's identity and
 * dimensions — used by search to detect drift between the operator's
 * picked model and the vectors already on disk without paying for a
 * full provider resolve.
 *
 * Returns null when no active model is set OR when the picked model
 * is unusable (inactive / chat-only / dim-less). Mirrors the same
 * validity gates as {@link resolveActiveEmbeddingConfig}.
 */
export async function getActiveEmbeddingModelSummary(): Promise<{
  modelId: string;
  dimensions: number;
} | null> {
  const settings = await prisma.aiOrchestrationSettings
    .findFirst({
      where: { slug: 'global' },
      select: { activeEmbeddingModelId: true },
    })
    .catch(() => null);

  const id = settings?.activeEmbeddingModelId;
  if (!id) {
    return null;
  }

  const model = await prisma.aiProviderModel
    .findUnique({
      where: { id },
      select: { modelId: true, dimensions: true, capabilities: true, isActive: true },
    })
    .catch(() => null);

  if (
    !model ||
    !model.isActive ||
    !model.capabilities.includes('embedding') ||
    !model.dimensions ||
    model.dimensions <= 0
  ) {
    return null;
  }

  return { modelId: model.modelId, dimensions: model.dimensions };
}

/**
 * If `AiOrchestrationSettings.activeEmbeddingModelId` is set, resolve
 * the embedder against that explicit choice. Returns `null` if the
 * setting is absent or points at a model that can't currently be used
 * (chat-only model, missing provider config, missing dimensions); the
 * caller falls back to provider-priority resolution.
 *
 * This is the path that lets operators pick from `AiProviderModel`
 * rows in the admin UI rather than living with the implicit Voyage →
 * local → OpenAI ordering.
 */
async function resolveActiveEmbeddingConfig(): Promise<EmbeddingProvider | null> {
  const settings = await prisma.aiOrchestrationSettings
    .findFirst({
      where: { slug: 'global' },
      select: { activeEmbeddingModelId: true },
    })
    .catch(() => null);

  const modelId = settings?.activeEmbeddingModelId;
  if (!modelId) {
    return null;
  }

  const model = await prisma.aiProviderModel
    .findUnique({
      where: { id: modelId },
      select: {
        providerSlug: true,
        modelId: true,
        dimensions: true,
        schemaCompatible: true,
        capabilities: true,
        isActive: true,
      },
    })
    .catch(() => null);

  if (!model || !model.isActive) {
    logger.warn(
      'Active embedding model is missing or inactive; falling back to provider priority',
      {
        activeEmbeddingModelId: modelId,
      }
    );
    return null;
  }

  if (!model.capabilities.includes('embedding')) {
    logger.warn('Active embedding model lacks the embedding capability; falling back', {
      activeEmbeddingModelId: modelId,
      capabilities: model.capabilities,
    });
    return null;
  }

  if (!model.dimensions || model.dimensions <= 0) {
    logger.warn('Active embedding model has no dimensions recorded; falling back', {
      activeEmbeddingModelId: modelId,
      modelId: model.modelId,
    });
    return null;
  }

  const providerConfig = await prisma.aiProviderConfig
    .findFirst({
      where: { slug: model.providerSlug, isActive: true },
    })
    .catch(() => null);

  if (!providerConfig) {
    logger.warn('Active embedding model has no matching active provider config; falling back', {
      activeEmbeddingModelId: modelId,
      providerSlug: model.providerSlug,
    });
    return null;
  }

  const apiKey = providerConfig.apiKeyEnvVar
    ? (process.env[providerConfig.apiKeyEnvVar] ?? null)
    : null;

  // Voyage uses its own canonical base URL when none is set; everyone
  // else needs an explicit `baseUrl`. Bail to fallback if a non-Voyage
  // provider is missing it.
  const baseUrl =
    providerConfig.baseUrl ??
    (providerConfig.providerType === 'voyage' ? 'https://api.voyageai.com/v1' : null);

  if (!baseUrl) {
    logger.warn('Active embedding provider has no baseUrl configured; falling back', {
      activeEmbeddingModelId: modelId,
      providerSlug: model.providerSlug,
    });
    return null;
  }

  return {
    baseUrl,
    apiKey,
    model: model.modelId,
    dimensions: model.dimensions,
    schemaCompatible: model.schemaCompatible ?? false,
    isLocal: providerConfig.isLocal,
    providerType: providerConfig.providerType,
  };
}

/**
 * Resolve the embedding provider.
 *
 * Preference order:
 *   1. `AiOrchestrationSettings.activeEmbeddingModelId` — the explicit
 *      operator pick, with dim and model coming from `AiProviderModel`.
 *   2. The legacy provider-priority chain: Voyage → local → OpenAI-
 *      compatible → OPENAI_API_KEY direct. Used until the operator
 *      picks a model, and as a safety net if the picked model becomes
 *      invalid (deactivated, dim cleared, provider config removed).
 *
 * The fallback always reports `FALLBACK_DIMENSIONS` (1536) because all
 * of its concrete branches are configured to produce 1536-dim vectors
 * today.
 */
async function resolveProvider(): Promise<EmbeddingProvider> {
  const active = await resolveActiveEmbeddingConfig();
  if (active) {
    return active;
  }

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
      dimensions: FALLBACK_DIMENSIONS,
      schemaCompatible: true, // voyage-3 supports `output_dimension`
      isLocal: false,
      providerType: 'voyage',
    };
  }

  // Prefer a local provider for embeddings (cheaper/faster). Local
  // models (nomic-embed-text) produce a fixed native dim and ignore
  // `dimensions`; `schemaCompatible: false` keeps us from sending it.
  const localProvider = providers.find((p) => p.isLocal);
  if (localProvider?.baseUrl) {
    return {
      baseUrl: localProvider.baseUrl,
      apiKey: localProvider.apiKeyEnvVar ? (process.env[localProvider.apiKeyEnvVar] ?? null) : null,
      model: 'nomic-embed-text',
      dimensions: FALLBACK_DIMENSIONS,
      schemaCompatible: false,
      isLocal: true,
      providerType: localProvider.providerType,
    };
  }

  // Fall back to OpenAI-compatible provider. Without an explicit
  // active-model pick, only the canonical text-embedding-3-* family is
  // assumed schema-compatible — other openai-compatible hosts may
  // error on `dimensions`, so default to false.
  const openaiCompatible = providers.find(
    (p) => p.providerType === 'openai-compatible' && p.baseUrl
  );
  if (openaiCompatible?.baseUrl) {
    const apiKey = openaiCompatible.apiKeyEnvVar
      ? (process.env[openaiCompatible.apiKeyEnvVar] ?? null)
      : null;
    const model = settingsModel || DEFAULT_MODEL;
    return {
      baseUrl: openaiCompatible.baseUrl,
      apiKey,
      model,
      dimensions: FALLBACK_DIMENSIONS,
      schemaCompatible: isOpenAiSchemaCompatibleModel(model),
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
  const model = settingsModel || DEFAULT_MODEL;
  return {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: openaiKey,
    model,
    dimensions: FALLBACK_DIMENSIONS,
    schemaCompatible: isOpenAiSchemaCompatibleModel(model),
    isLocal: false,
    providerType: 'openai-compatible',
  };
}

/**
 * Matches OpenAI's text-embedding-3-* family (the only OpenAI embedding
 * models that accept the `dimensions` parameter). Used by the legacy
 * provider-priority fallback; the active-model path consults the
 * registry's `schemaCompatible` flag directly.
 */
function isOpenAiSchemaCompatibleModel(model: string): boolean {
  return /^text-embedding-3-/.test(model);
}

/**
 * Call an OpenAI-compatible embeddings endpoint.
 */
async function callEmbeddingApi(
  provider: EmbeddingProvider,
  input: string | string[],
  inputType?: 'document' | 'query'
): Promise<{ embeddings: number[][]; inputTokens: number }> {
  // Point-of-use SSRF re-check, mirroring `provider-manager.ts` (#635).
  // Nothing on THIS path ran one: `resolveProvider` reads `AiProviderConfig`
  // straight from Prisma, and the only other guard is the Zod refine at
  // create/update — which seeds, imports and direct DB writes bypass, exactly
  // as provider-manager's own comment says. So hop 1 was unvalidated here, and
  // the redirect refusal below only ever covered hops 2+.
  //
  // An earlier version of the comment below asserted this check already
  // happened. It did not; that claim is what surfaced the gap.
  const urlCheck = checkSafeProviderUrl(provider.baseUrl, { allowLoopback: provider.isLocal });
  if (!urlCheck.ok) {
    logger.error('Embedding provider baseUrl rejected by SSRF guard at point of use', {
      providerType: provider.providerType,
      reason: urlCheck.reason,
    });
    throw new Error(`Embedding provider baseUrl is unsafe (${urlCheck.reason ?? 'blocked'})`);
  }

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    input,
  };

  // Voyage uses its own param name (`output_dimension`) and always
  // accepts an `input_type`. Drive both from the resolved provider.
  if (provider.providerType === 'voyage') {
    body['input_type'] = inputType ?? 'document';
    body['output_dimension'] = provider.dimensions;
  } else if (provider.schemaCompatible) {
    // OpenAI-style `dimensions` parameter — only safe for models
    // explicitly flagged schema-compatible (text-embedding-3-* and
    // anything an operator has registered as such). Sending it to a
    // model that doesn't support it errors on some hosts.
    body['dimensions'] = provider.dimensions;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // Refuse redirects (#635). `url` is built from the embedding provider's
      // admin-set `baseUrl`, and the check above validates only that first hop.
      // This is the ingestion path, so the body is whatever document the operator
      // uploaded; a followed redirect would post that text to a host nothing
      // validated.
      redirect: 'error',
    });
  } catch (err) {
    // undici renders a refused redirect, a DNS miss and a connection reset
    // alike as a bare `TypeError: fetch failed`, with the reason on `cause`.
    // Ingestion failures surface to the operator through this message, so
    // without unwrapping, a provider that started redirecting is
    // indistinguishable from one that is down — and the fix (re-point the
    // baseUrl) is invisible. Same reasoning as the webhook test route.
    throw new Error(`Embedding API request failed: ${describeFetchFailure(err)}`);
  }

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
 * Who to bill an embedding call to.
 *
 * Every field is optional and every one is omitted from the cost row when
 * absent — `AiCostLog.agentId`, `.conversationId` and `.workflowExecutionId` are
 * nullable foreign keys, so the choice at each call site is *a real row id* or
 * *nothing*. A placeholder is the one thing that cannot be written: it is
 * rejected with P2003 and `logCost` swallows the rejection, which is how three
 * separate cost sinks came to record nothing at all (#599, #600, #654).
 *
 * Before this existed, every embedding row landed with all three null and no
 * metadata: real spend, counted in the global total, attributable to nothing.
 * Ingestion paths still pass metadata only — there is no agent or conversation
 * behind a document upload — which is a deliberate limit, not an oversight.
 * See `.context/orchestration/capabilities.md`.
 */
export interface EmbeddingAttribution {
  /** Must be a real `AiAgent.id`. A workflow's synthetic label is not one. */
  agentId?: string;
  /** Must be a real `AiConversation.id`. */
  conversationId?: string;
  /** Must be a real `AiWorkflowExecution.id`. */
  workflowExecutionId?: string;
  /**
   * Must be a real `User.id`. Null/absent for work no person requested —
   * document ingestion, seeding, chunking — which is most callers here.
   *
   * NOT most of them, though, and that is the trap: the per-message embedder
   * and the knowledge-search paths run inside somebody's chat turn, so leaving
   * this unset there records spend a user caused against nobody, and drops it
   * from their Art. 15 export while the chat row for the SAME turn appears.
   * An embed visitor is not a `User` — guard with `isEmbedUserId` before
   * forwarding one (see `lib/embed/auth.ts`).
   */
  userId?: string | null;
  /**
   * Free-form tags. Carries `stepId` in from a workflow executor — without it
   * both execution cost readers drop the row (`if (!stepId) continue;`) — and a
   * `kind` on paths that have nothing else.
   */
  metadata?: Record<string, unknown>;
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
  /** Output dimension of `embedding`, persisted by callers as provenance. */
  dimensions: number;
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
  inputType?: 'document' | 'query',
  attribution?: EmbeddingAttribution
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
  //
  // The four spreads are written out here and again in `embedBatch` rather than
  // shared through a helper. A helper call is opaque to
  // `tests/unit/lib/orchestration/llm/cost-log-fk-attribution.test.ts`, which
  // reads these call sites statically to stop a fourth non-id reaching a
  // foreign key — and a guard that cannot see the site it guards is the shape
  // this whole area keeps failing at.
  void logCost({
    ...(attribution?.agentId ? { agentId: attribution.agentId } : {}),
    ...(attribution?.conversationId ? { conversationId: attribution.conversationId } : {}),
    ...(attribution?.workflowExecutionId
      ? { workflowExecutionId: attribution.workflowExecutionId }
      : {}),
    ...(attribution?.userId ? { userId: attribution.userId } : {}),
    ...(attribution?.metadata ? { metadata: attribution.metadata } : {}),
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
    dimensions: provider.dimensions,
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
  inputType?: 'document' | 'query',
  attribution?: EmbeddingAttribution
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
    ...(attribution?.agentId ? { agentId: attribution.agentId } : {}),
    ...(attribution?.conversationId ? { conversationId: attribution.conversationId } : {}),
    ...(attribution?.workflowExecutionId
      ? { workflowExecutionId: attribution.workflowExecutionId }
      : {}),
    ...(attribution?.userId ? { userId: attribution.userId } : {}),
    ...(attribution?.metadata ? { metadata: attribution.metadata } : {}),
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
      dimensions: provider.dimensions,
      embeddedAt,
    },
  };
}
