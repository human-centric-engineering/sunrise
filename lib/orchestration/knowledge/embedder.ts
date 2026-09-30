/**
 * Text Embedding Service
 *
 * Generates vector embeddings for text using configured LLM providers.
 * Chooses the provider and model here (the operator's pick, else a preference
 * chain over `AiProviderConfig` rows), then reaches the vendor through the
 * provider manager's `embedMany`, like every other core vendor call (t-740).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { calculateEmbeddingCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { CostOperation } from '@/types/orchestration';
import { isProviderEligible } from '@/lib/orchestration/llm/provider-eligibility';
import {
  NoEligibleProviderError,
  NoProviderConfiguredError,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider, isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { ProviderError } from '@/lib/orchestration/llm/provider';

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

/**
 * What the resolver chose: which provider row, which model, and how to ask.
 *
 * No URL and no key: the provider manager builds the client from the row,
 * with the same SSRF check, key resolution and redirect refusal as every
 * other vendor call. This used to carry both, because the embedder built its
 * own request.
 */
interface EmbeddingProvider {
  /** The `AiProviderConfig.slug` to fetch from the provider manager. */
  slug: string;
  model: string;
  /** Output dimension of `model`. Recorded as provenance, and requested when `sendDimensions`. */
  dimensions: number;
  /**
   * Whether to ask the vendor for `dimensions`. True for Voyage (it always
   * takes `output_dimension`) and for a model that accepts the OpenAI-style
   * `dimensions` parameter (text-embedding-3-*, or a row flagged
   * `schemaCompatible`). False for fixed-width models like nomic-embed-text,
   * which some hosts reject the parameter for.
   */
  sendDimensions: boolean;
  isLocal: boolean;
  /** Recorded on cost rows and provenance, as before t-740 — not the slug. */
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

  // Voyage uses its own canonical base URL when none is set; everyone
  // else needs an explicit `baseUrl`. Bail to fallback if a non-Voyage
  // provider is missing it — the provider manager would refuse to build it.
  if (!providerConfig.baseUrl && providerConfig.providerType !== 'voyage') {
    logger.warn('Active embedding provider has no baseUrl configured; falling back', {
      activeEmbeddingModelId: modelId,
      providerSlug: model.providerSlug,
    });
    return null;
  }

  return {
    slug: providerConfig.slug,
    model: model.modelId,
    dimensions: model.dimensions,
    sendDimensions: providerConfig.providerType === 'voyage' || (model.schemaCompatible ?? false),
    isLocal: providerConfig.isLocal,
    providerType: providerConfig.providerType,
  };
}

/**
 * Ask the app's provider-eligibility rule whether Sunrise may pick `slug` for
 * embedding on the caller's behalf.
 *
 * `source: 'primary'` because every arm of the chain below is Sunrise
 * choosing: nobody recorded a decision, we are walking a preference order. It
 * matches what `tryAudioRow`, `llm-runner` and `keyword-enricher` pass for the
 * same reason, so a rule already written in a fork covers this path for free.
 *
 * A denial skips the arm and the chain tries the next one — the audio loop's
 * shape, and the right one here: a fork that permits a local embedder but not
 * Voyage should get the local embedder, not a failure. A rule that permits
 * nothing runs off the end of the chain, which is fail-closed.
 */
async function permittedForEmbedding(
  slug: string,
  refusals: string[],
  seen: Map<string, boolean>
): Promise<boolean> {
  // A row can match two arms — an Ollama row is `isLocal` AND
  // `providerType: 'openai-compatible'`, which is the common local setup, not
  // an exotic one. Without this the rule is evaluated twice for the same slug
  // on every refusal, on the per-query knowledge-search path, and the slug is
  // recorded as two refusals. The seam's own guidance anticipates rules that do
  // policy lookups, so asking one twice per query is a cost worth not paying.
  const cached = seen.get(slug);
  if (cached !== undefined) return cached;

  const permitted = await isProviderEligible(slug, {
    task: 'embeddings',
    source: 'primary',
    primarySlug: null,
  });
  seen.set(slug, permitted);
  if (!permitted) {
    refusals.push(slug);
    logger.info('Skipping embedding provider — not permitted by the app eligibility rule', {
      providerSlug: slug,
    });
  }
  return permitted;
}

/**
 * Resolve the embedding provider.
 *
 * Preference order:
 *   1. `AiOrchestrationSettings.activeEmbeddingModelId` — the explicit
 *      operator pick, with dim and model coming from `AiProviderModel`.
 *   2. The legacy provider-priority chain: Voyage → local → OpenAI-
 *      compatible, over active provider rows. Used until the operator
 *      picks a model, and as a safety net if the picked model becomes
 *      invalid (deactivated, dim cleared, provider config removed).
 *
 * The fallback always reports `FALLBACK_DIMENSIONS` (1536) because all
 * of its concrete branches are configured to produce 1536-dim vectors
 * today.
 *
 * **Every arm of the chain is filtered by the provider-eligibility seam; the
 * operator's pin at (1) is not.** That is the same line the rest of the tree
 * draws — Sunrise's own choices are constrained, an operator's recorded
 * decision is not — and it matters more here than anywhere else, because the
 * pin is not sticky: five separate checks drop it through to the chain (missing
 * or inactive — one `if`, and why this is five and not six; no `embedding`
 * capability; no `dimensions`; no active `AiProviderConfig`; non-Voyage with no
 * `baseUrl`). Deactivating one row
 * moves an install from the unfiltered line to the filtered one silently,
 * which is why the drop-through is logged.
 *
 * **It chooses; it does not call.** The chosen row is fetched from the provider
 * manager and called through `LlmProvider.embedMany` (t-740), so embedding goes
 * through the same Proxy, key resolution and SSRF check as chat.
 *
 * **There is no longer a bare `OPENAI_API_KEY` arm** (t-740). It sent documents
 * to OpenAI with no provider row an admin could see, and dated from before
 * provider rows and env-key detection existed. An install that relied on it
 * adds OpenAI as a provider (the Providers page detects the key), which the
 * OpenAI-compatible arm then picks with the same model and width.
 */
async function resolveProvider(): Promise<EmbeddingProvider> {
  const active = await resolveActiveEmbeddingConfig();
  if (active) {
    return active;
  }

  // Slugs the eligibility rule turned down on this pass. Only used to pick the
  // right terminal error — see the end of this function.
  const refusals: string[] = [];
  const seen = new Map<string, boolean>();

  // Check for configured providers that support embeddings
  const providers = await prisma.aiProviderConfig.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  // Resolve the operator-configured embedding model. Voyage and Ollama
  // ignore this — they have their own canonical embedding models — but
  // every other openai-compatible host honours it.
  const settingsModel = await getDefaultModelForTask('embeddings').catch(() => DEFAULT_MODEL);

  // Each category is walked in full, not sampled with `find`. A refusal has to
  // skip the ROW, not the category: an org that approves `voyage-eu` and not
  // `voyage-us` must still get Voyage when both rows are active and the refused
  // one happens to sort first. `find` returned that one row, the refusal
  // abandoned Voyage entirely, and the chain fell through to a provider the org
  // had not asked for — or to no provider at all. This is what "the audio loop's
  // shape" means; `tryAudioRow`'s caller iterates every matrix row.

  // Prefer Voyage AI provider (best retrieval quality, free tier)
  for (const voyageProvider of providers) {
    if (voyageProvider.providerType !== 'voyage') continue;
    if (!(await permittedForEmbedding(voyageProvider.slug, refusals, seen))) continue;
    logger.debug('Embedding provider resolved by the fallback chain', {
      arm: 'voyage',
      providerSlug: voyageProvider.slug,
    });
    return {
      slug: voyageProvider.slug,
      model: 'voyage-3',
      dimensions: FALLBACK_DIMENSIONS,
      sendDimensions: true, // voyage-3 supports `output_dimension`
      isLocal: false,
      providerType: 'voyage',
    };
  }

  // Prefer a local provider for embeddings (cheaper/faster). Local
  // models (nomic-embed-text) produce a fixed native dim and ignore
  // `dimensions`; `sendDimensions: false` keeps us from sending it.
  for (const localProvider of providers) {
    // Shape first, policy second: a row with no `baseUrl` is unusable whatever
    // the rule says, and consulting the rule for it would record a refusal that
    // never happened and steer the terminal error to the wrong message.
    if (!localProvider.isLocal || !localProvider.baseUrl) continue;
    if (!(await permittedForEmbedding(localProvider.slug, refusals, seen))) continue;
    logger.debug('Embedding provider resolved by the fallback chain', {
      arm: 'local',
      providerSlug: localProvider.slug,
    });
    return {
      slug: localProvider.slug,
      model: 'nomic-embed-text',
      dimensions: FALLBACK_DIMENSIONS,
      sendDimensions: false,
      isLocal: true,
      providerType: localProvider.providerType,
    };
  }

  // Fall back to OpenAI-compatible provider. Without an explicit
  // active-model pick, only the canonical text-embedding-3-* family is
  // assumed schema-compatible — other openai-compatible hosts may
  // error on `dimensions`, so default to false.
  for (const openaiCompatible of providers) {
    if (openaiCompatible.providerType !== 'openai-compatible' || !openaiCompatible.baseUrl)
      continue;
    if (!(await permittedForEmbedding(openaiCompatible.slug, refusals, seen))) continue;
    const model = settingsModel || DEFAULT_MODEL;
    logger.debug('Embedding provider resolved by the fallback chain', {
      arm: 'openai-compatible',
      providerSlug: openaiCompatible.slug,
    });
    return {
      slug: openaiCompatible.slug,
      model,
      dimensions: FALLBACK_DIMENSIONS,
      sendDimensions: isOpenAiSchemaCompatibleModel(model),
      isLocal: false,
      providerType: 'openai-compatible',
    };
  }

  // Two distinct endings, kept distinct: "nothing is set up" sends an operator
  // to the setup wizard, and "what is set up was refused" sends them to
  // whoever wrote the rule. Collapsing them into one message would send half
  // of the readers to the wrong place. The flag is what separates them — an
  // install with only an Anthropic row reaches the end of this chain having
  // been refused nothing, and must not be told a policy turned it away.
  if (refusals.length > 0) {
    throw new NoEligibleProviderError(
      'No permitted embedding provider. Every embedding provider this install could ' +
        'have used was refused by the app provider-eligibility rule ' +
        '(lib/app/llm-providers.ts).'
    );
  }
  // The bare-key arm is gone (t-740). An install that relied on it has the key
  // set and no row, and would otherwise read the plain "nothing configured"
  // and not know why a working setup stopped. Say what changed and the fix.
  if (isApiKeyEnvVarSet('OPENAI_API_KEY')) {
    logger.warn(
      'OPENAI_API_KEY is set but no embedding provider row exists. The key alone no longer ' +
        'enables embeddings: add OpenAI as a provider (the Providers page detects the key).',
      {}
    );
    throw new NoProviderConfiguredError(
      'No embedding provider configured. OPENAI_API_KEY is set, but the key alone no longer ' +
        'enables embeddings: add OpenAI as a provider in the admin settings (the Providers ' +
        'page detects the key).'
    );
  }
  throw new NoProviderConfiguredError(
    'No embedding provider configured. Add an embedding provider (OpenAI, Voyage or a local ' +
      'one) in the admin settings.'
  );
}

/**
 * Why this install can or cannot embed right now.
 *
 * A boolean was the first cut and it threw away the distinction
 * `resolveProvider` had just paid to keep. `NoEligibleProviderError`'s own
 * docstring says reporting "nothing is configured" for "your policy allows none
 * of it" sends someone to re-add providers that are already there — and that is
 * exactly what the admin banner does with a bare `false`: it prints
 * "Add an embedding provider", which will not help and never mentions a policy.
 *
 * `'unknown'` is the fourth state and it is not padding. The chain's
 * `aiProviderConfig.findMany` is the one query with no `.catch()`, so a pool
 * timeout is a failure to ANSWER, not an answer of "no". Reporting it as a
 * verdict prints the same wrong remedy; 500ing instead does not help either,
 * because the caller does `if (!res.ok) return` and falls back to the same
 * misleading `false` while also losing the chunk counts.
 */
export type EmbeddingAvailability =
  /** A provider resolves; embedding will run. */
  | 'ok'
  /** Nothing is set up. The operator wants the setup wizard or a provider row. */
  | 'none_configured'
  /** Providers exist and the app's eligibility rule refuses every one of them. */
  | 'none_permitted'
  /** We could not find out — a transient failure, not a verdict. */
  | 'unknown';

/**
 * Can this install embed right now, and if not, why?
 *
 * Answers by *running the resolver* rather than by re-deriving it from row
 * counts. Those two used to be the same question and this branch made them
 * different: an install can have active provider rows and an `OPENAI_API_KEY`
 * while the app's eligibility rule refuses every one of them.
 *
 * Never throws. A caller rendering an operator-facing remedy needs an answer
 * for every case, and `'unknown'` is the honest one when the lookup itself
 * failed — see {@link EmbeddingAvailability}.
 *
 * Costs one eligibility evaluation per arm tried, so treat it as the status
 * check it is and do not put it on a per-request path.
 */
export async function resolveEmbeddingAvailability(): Promise<EmbeddingAvailability> {
  try {
    await resolveProvider();
    return 'ok';
  } catch (err) {
    if (err instanceof NoProviderConfiguredError) {
      logger.info('No embedding provider configured', { reason: err.message });
      return 'none_configured';
    }
    if (err instanceof NoEligibleProviderError) {
      logger.warn('Every embedding provider was refused by the app eligibility rule', {
        reason: err.message,
      });
      return 'none_permitted';
    }
    logger.error('Could not determine embedding availability', err, {});
    return 'unknown';
  }
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
 * Embed a batch through the chosen provider row (t-740).
 *
 * Reaches the vendor via the provider manager, so the call is built from the
 * row with the same key resolution, SSRF check and redirect refusal as chat,
 * and is counted by the in-flight Proxy. A provider class without `embedMany`
 * (Anthropic, or a fork class written against the older contract) cannot do
 * knowledge embedding, and that is an error, not a fall back to the
 * single-text `embed`, which could return vectors of the wrong width.
 */
async function callEmbeddingProvider(
  provider: EmbeddingProvider,
  texts: string[],
  inputType?: 'document' | 'query'
): Promise<{ embeddings: number[][]; inputTokens: number }> {
  const llm = await getProvider(provider.slug);
  if (!llm.embedMany) {
    throw new ProviderError(
      `Provider "${provider.slug}" cannot be used for knowledge embedding: it does not ` +
        'implement embedMany.',
      { code: 'embedding_unsupported', retriable: false }
    );
  }

  const result = await llm.embedMany(texts, {
    model: provider.model,
    ...(provider.sendDimensions ? { dimensions: provider.dimensions } : {}),
    ...(inputType ? { inputType } : {}),
  });

  if (result.embeddings.length !== texts.length) {
    throw new Error(
      `Embedding API returned ${result.embeddings.length} embeddings for ${texts.length} texts`
    );
  }

  return {
    embeddings: result.embeddings,
    inputTokens: result.inputTokens ?? estimateEmbeddingTokens(texts),
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

  const { embeddings, inputTokens } = await callEmbeddingProvider(provider, [text], inputType);
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

    const { embeddings, inputTokens } = await callEmbeddingProvider(provider, batch, inputType);
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
