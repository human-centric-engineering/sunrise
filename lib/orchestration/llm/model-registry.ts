/**
 * Dynamic Model Registry
 *
 * Keeps an up-to-date catalogue of LLM models with current pricing,
 * context windows, and capabilities. The registry has three sources,
 * each layered on the previous:
 *
 * 1. A static fallback map (compiled in) covering common frontier,
 *    mid-tier, and local models. Always available — used when
 *    OpenRouter is unreachable or before the first refresh.
 * 2. OpenRouter's public `/api/v1/models` endpoint, which provides
 *    300+ models with current pricing and capabilities. Cached for
 *    24 hours. No API key required.
 * 3. Per-provider `/v1/models` discovery, which marks entries as
 *    `available: true` when they are actually reachable through a
 *    configured provider (e.g. Ollama lists only locally-pulled models).
 *
 * Consumers use `getModel(id)` / `getModelsByTier(tier)` /
 * `getAvailableModels(providerName?)` to query the merged view.
 *
 * Platform-agnostic: no Next.js imports, no Node-only APIs.
 */

import { z } from 'zod';

import { logger } from '@/lib/logging';
import {
  fetchWithTimeout,
  ProviderError,
  type LlmProvider,
} from '@/lib/orchestration/llm/provider';
import type { ModelInfo, ModelTier } from '@/lib/orchestration/llm/types';
import { TASK_TYPES, type TaskType } from '@/types/orchestration';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Negative-cache window after a refresh failure. Without this, a
// downstream OpenRouter outage would cause every panel load to make a
// fresh 10-second timeout call until OpenRouter recovers — turning a
// remote outage into a local user-facing slowdown. 5 minutes is short
// enough that operators won't notice when OpenRouter recovers, but
// long enough to absorb a flurry of concurrent admin requests.
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

interface RegistryState {
  /** Map keyed by canonical id (and also indexed by full `provider/id` form). */
  models: Map<string, ModelInfo>;
  /** Epoch ms of last successful refresh, 0 if never refreshed. */
  fetchedAt: number;
  /** Epoch ms of last failed refresh attempt, 0 if no recent failure. */
  failedAt: number;
}

let state: RegistryState = { models: buildFallbackMap(), fetchedAt: 0, failedAt: 0 };
let inflightRefresh: Promise<void> | null = null;

/**
 * Fetch the OpenRouter model catalogue and merge it into the registry.
 *
 * Deduplicates concurrent callers via `inflightRefresh`. Falls back
 * silently to the static map on failure — callers can still query
 * the registry afterwards. Failures negative-cache for
 * FAILURE_BACKOFF_MS so a downstream outage doesn't cause every
 * caller to retry the timeout.
 */
export async function refreshFromOpenRouter(options: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (!options.force) {
    if (state.fetchedAt !== 0 && now - state.fetchedAt < CACHE_TTL_MS) return;
    if (state.failedAt !== 0 && now - state.failedAt < FAILURE_BACKOFF_MS) return;
  }

  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async () => {
    try {
      logger.debug('Refreshing model registry from OpenRouter');
      const response = await fetchWithTimeout(
        OPENROUTER_MODELS_URL,
        { method: 'GET', headers: { Accept: 'application/json' } },
        OPENROUTER_FETCH_TIMEOUT_MS
      );
      if (!response.ok) {
        throw new ProviderError(`OpenRouter returned ${response.status}`, {
          code: `http_${response.status}`,
          status: response.status,
          retriable: response.status >= 500 || response.status === 429,
        });
      }
      const raw: unknown = await response.json();
      const parsed = openRouterResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ProviderError('OpenRouter response failed schema validation', {
          code: 'invalid_openrouter_response',
          retriable: false,
          cause: parsed.error,
        });
      }
      const body = parsed.data;

      const merged = new Map<string, ModelInfo>(buildFallbackMap());
      let added = 0;
      for (const entry of body.data) {
        const info = parseOpenRouterEntry(entry);
        if (!info) continue;
        merged.set(info.id, info);
        if (entry.id !== info.id) merged.set(entry.id, info);
        added += 1;
      }

      // Successful refresh — clear the failure timestamp so the next
      // expiry of the success TTL gets a clean retry, not a backoff.
      state = { models: merged, fetchedAt: Date.now(), failedAt: 0 };
      logger.info('Model registry refreshed from OpenRouter', { modelCount: added });
    } catch (err) {
      logger.warn('Model registry refresh failed; using fallback map', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Preserve the existing models map (already initialised with the
      // fallback at module load) and stamp failedAt so the next call
      // within FAILURE_BACKOFF_MS short-circuits without another fetch.
      state = { ...state, failedAt: Date.now() };
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

/**
 * Ask a configured provider which models it can actually serve, and
 * mark matching registry entries as `available: true`. Unknown ids
 * discovered this way are inserted as synthetic entries so they are
 * still returnable from `getModelsByProvider`.
 */
export async function refreshFromProvider(provider: LlmProvider): Promise<ModelInfo[]> {
  try {
    const discovered = await provider.listModels();
    const updated = new Map(state.models);
    for (const model of discovered) {
      const existing = updated.get(model.id);
      if (existing) {
        updated.set(model.id, { ...existing, available: true });
      } else {
        updated.set(model.id, { ...model, available: true });
      }
    }
    state = { ...state, models: updated };
    return discovered;
  } catch (err) {
    logger.warn('refreshFromProvider failed', {
      provider: provider.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Return all models, optionally filtered to a single provider. */
export function getAvailableModels(providerName?: string): ModelInfo[] {
  const all = dedupeModels(state.models);
  if (!providerName) return all;
  return all.filter((m) => m.provider === providerName);
}

/** Look up a single model by canonical or prefixed id. Returns undefined if absent. */
export function getModel(id: string): ModelInfo | undefined {
  return state.models.get(id);
}

/** Filter models by tier. */
export function getModelsByTier(tier: ModelTier): ModelInfo[] {
  return dedupeModels(state.models).filter((m) => m.tier === tier);
}

/** Filter models by provider id. */
export function getModelsByProvider(provider: string): ModelInfo[] {
  return dedupeModels(state.models).filter((m) => m.provider === provider);
}

/**
 * Return the epoch timestamp (ms) when the registry was last populated
 * from OpenRouter. `0` means the registry has never been refreshed and
 * is running on the static fallback map only.
 */
export function getRegistryFetchedAt(): number {
  return state.fetchedAt;
}

/**
 * Reset the registry. Intended for tests only — production code should
 * rely on the 24-hour TTL and `refreshFromOpenRouter({ force: true })`.
 */
export function __resetForTests(): void {
  state = { models: buildFallbackMap(), fetchedAt: 0, failedAt: 0 };
  inflightRefresh = null;
}

// ---------------------------------------------------------------------------
// Task default-model helpers (registry-only; DB read lives in settings-resolver.ts)
// ---------------------------------------------------------------------------

/**
 * Compute sensible defaults for the task → model map from whatever is
 * currently in the registry. Used on first-seed and as a fallback when
 * the stored map is missing a key.
 *
 * Preference order:
 *   - `chat` / `routing` — cheapest budget-tier model
 *   - `reasoning` — frontier-tier, falls back to mid, then any non-local
 *   - `embeddings` — first embeddings-capable entry, else any non-local
 */
export function computeDefaultModelMap(): Record<TaskType, string> {
  const all = dedupeModels(state.models).filter((m) => m.tier !== 'local');
  const byCost = [...all].sort((a, b) => a.inputCostPerMillion - b.inputCostPerMillion);
  const budget = byCost.find((m) => m.tier === 'budget') ?? byCost[0];
  const mid = byCost.find((m) => m.tier === 'mid') ?? budget;
  const frontier = byCost.find((m) => m.tier === 'frontier') ?? mid;

  // No embeddings tier in the registry today — fall back to the cheapest non-local.
  const embeddings = budget;

  // If the registry is empty (test or refresh-failed state), fall back to known
  // ids from the fallback map.
  return {
    routing: budget?.id ?? 'claude-haiku-4-5',
    chat: budget?.id ?? 'claude-haiku-4-5',
    reasoning: frontier?.id ?? 'claude-opus-4-6',
    embeddings: embeddings?.id ?? 'claude-haiku-4-5',
  };
}

/**
 * Validate a partial `defaultModels` map: every chat-task model id must
 * resolve through `getModel()`. Returns an array of per-task error
 * descriptors (empty if everything is valid). Used by the Zod schema in
 * `lib/validations/orchestration.ts` so the route never sees an unknown id.
 *
 * Embeddings are validated only as a non-empty string. Embedding model
 * ids (e.g. `text-embedding-3-small`, `voyage-3`, `nomic-embed-text`)
 * live in a separate DB-backed registry (`embedding-models.ts`) and
 * cannot be looked up synchronously here. The admin UI's embeddings
 * dropdown is sourced from that registry, so operators can only pick
 * valid options through normal flow; if someone POSTs a bogus id
 * directly, the embedder will surface a clear runtime error when the
 * provider rejects the model.
 */
export function validateTaskDefaults(
  defaults: Partial<Record<TaskType, string>>
): Array<{ task: TaskType; message: string }> {
  const errors: Array<{ task: TaskType; message: string }> = [];
  for (const task of TASK_TYPES) {
    const id = defaults[task];
    if (id === undefined) continue;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push({ task, message: 'Model id must be a non-empty string' });
      continue;
    }
    if (task === 'embeddings') continue;
    if (!getModel(id)) {
      errors.push({ task, message: `Unknown model id: ${id}` });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// OpenRouter response parsing
// ---------------------------------------------------------------------------

/**
 * Zod schema for the OpenRouter `/api/v1/models` response. Only fields
 * we actually consume are validated; `.passthrough()` keeps unknown
 * fields intact but doesn't lie about their types. Everything besides
 * `id` is optional because OpenRouter's catalogue is heterogeneous.
 */
const openRouterModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    context_length: z.number().optional(),
    pricing: z
      .object({
        prompt: z.string().optional(),
        completion: z.string().optional(),
      })
      .partial()
      .optional(),
    supported_parameters: z.array(z.string()).optional(),
  })
  .passthrough();

const openRouterResponseSchema = z.object({
  data: z.array(openRouterModelSchema),
});

type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

function parseOpenRouterEntry(entry: OpenRouterModel): ModelInfo | null {
  if (!entry || typeof entry.id !== 'string') return null;

  const [providerPrefix, ...rest] = entry.id.split('/');
  const canonicalId = rest.length > 0 ? rest.join('/') : entry.id;
  const provider = rest.length > 0 && providerPrefix ? providerPrefix : 'unknown';

  const promptPerToken = parseFloat(entry.pricing?.prompt ?? '0');
  const completionPerToken = parseFloat(entry.pricing?.completion ?? '0');
  const inputCostPerMillion = Number.isFinite(promptPerToken) ? promptPerToken * 1_000_000 : 0;
  const outputCostPerMillion = Number.isFinite(completionPerToken)
    ? completionPerToken * 1_000_000
    : 0;

  const supportsTools = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.includes('tools')
    : false;

  return {
    id: canonicalId,
    name: entry.name ?? canonicalId,
    provider,
    tier: classifyTier(inputCostPerMillion),
    inputCostPerMillion,
    outputCostPerMillion,
    maxContext: entry.context_length ?? 0,
    supportsTools,
  };
}

function classifyTier(inputCostPerMillion: number): ModelTier {
  if (inputCostPerMillion <= 0) return 'local';
  if (inputCostPerMillion <= 0.5) return 'budget';
  if (inputCostPerMillion <= 5) return 'mid';
  return 'frontier';
}

function dedupeModels(models: Map<string, ModelInfo>): ModelInfo[] {
  const seen = new Set<ModelInfo>();
  for (const info of models.values()) seen.add(info);
  return Array.from(seen);
}

// ---------------------------------------------------------------------------
// Static fallback map
// ---------------------------------------------------------------------------

/**
 * Curated fallback catalogue used when OpenRouter is unreachable or
 * the registry is queried before its first refresh. Pricing is
 * approximate and intended for accounting/display, not for billing;
 * `refreshFromOpenRouter` overrides these entries with live values as
 * soon as it completes.
 *
 * Covers the Anthropic Claude family (Opus 4.6 / Sonnet 4.6 / Haiku 4.5),
 * OpenAI GPT-4o family, Together / Fireworks / Groq OSS hosts, and a
 * placeholder `local:generic` row that local providers can clone.
 */
function buildFallbackMap(): Map<string, ModelInfo> {
  const entries: ModelInfo[] = [
    // Anthropic
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      provider: 'anthropic',
      tier: 'frontier',
      inputCostPerMillion: 15,
      outputCostPerMillion: 75,
      maxContext: 200_000,
      supportsTools: true,
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      tier: 'mid',
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      maxContext: 200_000,
      supportsTools: true,
    },
    {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      provider: 'anthropic',
      tier: 'budget',
      inputCostPerMillion: 1,
      outputCostPerMillion: 5,
      maxContext: 200_000,
      supportsTools: true,
    },
    {
      id: 'claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5 (2025-10-01)',
      provider: 'anthropic',
      tier: 'budget',
      inputCostPerMillion: 1,
      outputCostPerMillion: 5,
      maxContext: 200_000,
      supportsTools: true,
    },
    // OpenAI
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      provider: 'openai',
      tier: 'frontier',
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 10,
      maxContext: 128_000,
      supportsTools: true,
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      provider: 'openai',
      tier: 'budget',
      inputCostPerMillion: 0.15,
      outputCostPerMillion: 0.6,
      maxContext: 128_000,
      supportsTools: true,
    },
    // Together
    {
      id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      name: 'Llama 3.3 70B Instruct Turbo',
      provider: 'together',
      tier: 'mid',
      inputCostPerMillion: 0.88,
      outputCostPerMillion: 0.88,
      maxContext: 131_072,
      supportsTools: true,
    },
    // Fireworks
    {
      id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      name: 'Llama 3.3 70B (Fireworks)',
      provider: 'fireworks',
      tier: 'mid',
      inputCostPerMillion: 0.9,
      outputCostPerMillion: 0.9,
      maxContext: 131_072,
      supportsTools: true,
    },
    // Groq
    {
      id: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B Versatile (Groq)',
      provider: 'groq',
      tier: 'budget',
      inputCostPerMillion: 0.59,
      outputCostPerMillion: 0.79,
      maxContext: 131_072,
      supportsTools: true,
    },
    // Local placeholder
    {
      id: 'local:generic',
      name: 'Local Model (generic)',
      provider: 'local',
      tier: 'local',
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      maxContext: 8_192,
      supportsTools: false,
    },
  ];

  const map = new Map<string, ModelInfo>();
  for (const info of entries) map.set(info.id, info);
  return map;
}
