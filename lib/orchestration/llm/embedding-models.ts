/**
 * Embedding Model Registry
 *
 * Static, curated catalogue of embedding models from major providers.
 * Used by the compare-providers modal, advisory copy, and the
 * `/api/v1/admin/orchestration/embedding-models` endpoint.
 *
 * No runtime discovery — this is a hand-maintained snapshot. Models
 * that can output 1 536-dimension vectors (matching the pgvector
 * `vector(1536)` column) are marked `schemaCompatible: true`.
 */

/** A single embedding model entry in the registry. */
export interface EmbeddingModelInfo {
  /** Unique key: `provider/model` */
  id: string;
  /** Display name shown in the compare table. */
  name: string;
  /** Provider brand (e.g. "Voyage AI", "OpenAI"). */
  provider: string;
  /** Model id sent to the API (e.g. "voyage-3", "text-embedding-3-small"). */
  model: string;
  /** Native output dimensions (before any truncation param). */
  dimensions: number;
  /**
   * Can this model produce 1 536-dim vectors compatible with the
   * `AiKnowledgeChunk.embedding vector(1536)` column?
   *
   * `true` means either (a) native output is 1 536, or (b) the API
   * accepts an `output_dimension` / `dimensions` parameter.
   */
  schemaCompatible: boolean;
  /** Approximate cost per 1 M tokens (USD). 0 = free or local. */
  costPerMillionTokens: number;
  /** Whether the provider offers a free tier or free credits. */
  hasFreeTier: boolean;
  /** Whether this is a local/self-hosted model (e.g. Ollama). */
  local: boolean;
  /** Relative quality rating: "high", "medium", or "budget". */
  quality: 'high' | 'medium' | 'budget';
  /** Short description of strengths. */
  strengths: string;
  /** One-line setup instruction. */
  setup: string;
}

/**
 * Curated list of embedding models.
 *
 * Sorted by recommended-first: schema-compatible, then quality, then cost.
 */
export const EMBEDDING_MODELS: readonly EmbeddingModelInfo[] = [
  // --- Voyage AI ---
  {
    id: 'voyage/voyage-3',
    name: 'Voyage 3',
    provider: 'Voyage AI',
    model: 'voyage-3',
    dimensions: 1024,
    schemaCompatible: true, // output_dimension: 1536 supported
    costPerMillionTokens: 0.06,
    hasFreeTier: true,
    local: false,
    quality: 'high',
    strengths:
      'Top-tier retrieval quality; built by ex-Anthropic researchers; free 200 M tokens/month',
    setup: 'Sign up at voyageai.com → copy API key → add as Voyage AI provider',
  },
  // --- OpenAI ---
  {
    id: 'openai/text-embedding-3-small',
    name: 'text-embedding-3-small',
    provider: 'OpenAI',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    schemaCompatible: true, // native 1536
    costPerMillionTokens: 0.02,
    hasFreeTier: false,
    local: false,
    quality: 'medium',
    strengths: 'Low cost; native 1 536 dimensions; good general-purpose quality',
    setup:
      'OpenAI API key → add as OpenAI-compatible provider with base URL https://api.openai.com/v1',
  },
  {
    id: 'openai/text-embedding-3-large',
    name: 'text-embedding-3-large',
    provider: 'OpenAI',
    model: 'text-embedding-3-large',
    dimensions: 3072,
    schemaCompatible: true, // dimensions: 1536 param supported
    costPerMillionTokens: 0.13,
    hasFreeTier: false,
    local: false,
    quality: 'high',
    strengths: 'Highest quality OpenAI embedding; supports dimension reduction to 1 536',
    setup:
      'OpenAI API key → add as OpenAI-compatible provider with base URL https://api.openai.com/v1',
  },
  // --- Cohere ---
  {
    id: 'cohere/embed-english-v3.0',
    name: 'Embed English v3',
    provider: 'Cohere',
    model: 'embed-english-v3.0',
    dimensions: 1024,
    schemaCompatible: false,
    costPerMillionTokens: 0.1,
    hasFreeTier: true,
    local: false,
    quality: 'high',
    strengths: 'Excellent English retrieval; search/classification input types; free trial tier',
    setup: 'Cohere API key → add as OpenAI-compatible provider (requires adapter)',
  },
  {
    id: 'cohere/embed-multilingual-v3.0',
    name: 'Embed Multilingual v3',
    provider: 'Cohere',
    model: 'embed-multilingual-v3.0',
    dimensions: 1024,
    schemaCompatible: false,
    costPerMillionTokens: 0.1,
    hasFreeTier: true,
    local: false,
    quality: 'high',
    strengths: 'Best-in-class multilingual support; 100+ languages',
    setup: 'Cohere API key → add as OpenAI-compatible provider (requires adapter)',
  },
  // --- Google ---
  {
    id: 'google/text-embedding-004',
    name: 'text-embedding-004',
    provider: 'Google',
    model: 'text-embedding-004',
    dimensions: 768,
    schemaCompatible: false,
    costPerMillionTokens: 0.00625,
    hasFreeTier: true,
    local: false,
    quality: 'medium',
    strengths: 'Very low cost; generous free tier; good for prototyping',
    setup: 'Google AI API key → not directly compatible (768-dim, requires schema change)',
  },
  // --- Mistral ---
  {
    id: 'mistral/mistral-embed',
    name: 'Mistral Embed',
    provider: 'Mistral',
    model: 'mistral-embed',
    dimensions: 1024,
    schemaCompatible: false,
    costPerMillionTokens: 0.1,
    hasFreeTier: false,
    local: false,
    quality: 'medium',
    strengths: 'Good European-language support; OpenAI-compatible API',
    setup:
      'Mistral API key → add as OpenAI-compatible provider with base URL https://api.mistral.ai/v1',
  },
  // --- Ollama (local) ---
  {
    id: 'ollama/nomic-embed-text',
    name: 'nomic-embed-text',
    provider: 'Ollama',
    model: 'nomic-embed-text',
    dimensions: 768,
    schemaCompatible: false, // 768-dim, not 1536
    costPerMillionTokens: 0,
    hasFreeTier: true,
    local: true,
    quality: 'medium',
    strengths: 'Free; runs locally; no data leaves your machine; good quality for size',
    setup:
      'Install Ollama → ollama pull nomic-embed-text → add as local OpenAI-compatible provider',
  },
  {
    id: 'ollama/mxbai-embed-large',
    name: 'mxbai-embed-large',
    provider: 'Ollama',
    model: 'mxbai-embed-large',
    dimensions: 1024,
    schemaCompatible: false, // 1024-dim, not 1536
    costPerMillionTokens: 0,
    hasFreeTier: true,
    local: true,
    quality: 'medium',
    strengths: 'Free; local; larger context window than nomic; strong retrieval benchmarks',
    setup:
      'Install Ollama → ollama pull mxbai-embed-large → add as local OpenAI-compatible provider',
  },
] as const;

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

export interface EmbeddingModelFilters {
  schemaCompatibleOnly?: boolean;
  hasFreeTier?: boolean;
  local?: boolean;
}

/** Return models matching the given filters. */
export function filterEmbeddingModels(filters: EmbeddingModelFilters = {}): EmbeddingModelInfo[] {
  let result: EmbeddingModelInfo[] = [...EMBEDDING_MODELS];

  if (filters.schemaCompatibleOnly) {
    result = result.filter((m) => m.schemaCompatible);
  }
  if (filters.hasFreeTier) {
    result = result.filter((m) => m.hasFreeTier);
  }
  if (filters.local !== undefined) {
    result = result.filter((m) => m.local === filters.local);
  }

  return result;
}
