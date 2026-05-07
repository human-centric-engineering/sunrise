/**
 * Known LLM provider registry
 *
 * Static catalogue of LLM providers Sunrise recognises out of the box.
 * Each entry binds a provider flavour to its env-var name(s), default
 * base URL, and a recommended chat / embedding model. The setup wizard
 * uses this registry to surface "We detected `ANTHROPIC_API_KEY` —
 * configure Anthropic now?" cards.
 *
 * The shape is intentionally narrower than `FLAVORS` in the provider
 * form: that registry drives create/edit form rendering (groups,
 * descriptions, `showBaseUrl` toggles); this one is just enough to
 * detect env vars and pre-fill the resulting `AiProviderConfig` row.
 *
 * Multiple env-var names per provider are supported because vendors
 * are inconsistent (`GOOGLE_API_KEY` vs `GEMINI_API_KEY`,
 * `GOOGLE_AI_API_KEY`). Detection treats them as alternatives — the
 * first one set in `process.env` wins.
 */

export interface KnownProvider {
  /** Stable slug used as the default `AiProviderConfig.slug`. */
  slug: string;
  /** Display name used as the default `AiProviderConfig.name`. */
  name: string;
  /** `AiProviderConfig.providerType` value. */
  providerType: 'anthropic' | 'openai-compatible' | 'voyage';
  /** Default `AiProviderConfig.baseUrl`. `null` for vendors with hardcoded SDK URLs. */
  defaultBaseUrl: string | null;
  /**
   * Env var names this provider may use. The detection helper picks
   * the first one set in `process.env`. Empty for `isLocal` providers
   * (Ollama needs no key).
   */
  apiKeyEnvVars: string[];
  /** True for loopback / on-box providers that don't need an API key. */
  isLocal: boolean;
  /** Recommended chat model id when the operator picks this provider. */
  suggestedDefaultChatModel: string | null;
  /** Recommended embedding model id, or `null` if the provider has none. */
  suggestedEmbeddingModel: string | null;
}

export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
  {
    slug: 'anthropic',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultBaseUrl: null,
    apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
    isLocal: false,
    suggestedDefaultChatModel: 'claude-sonnet-4-6',
    suggestedEmbeddingModel: null,
  },
  {
    slug: 'openai',
    name: 'OpenAI',
    providerType: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    isLocal: false,
    suggestedDefaultChatModel: 'gpt-4o-mini',
    suggestedEmbeddingModel: 'text-embedding-3-small',
  },
  {
    slug: 'voyage',
    name: 'Voyage AI',
    providerType: 'voyage',
    defaultBaseUrl: 'https://api.voyageai.com/v1',
    apiKeyEnvVars: ['VOYAGE_API_KEY'],
    isLocal: false,
    suggestedDefaultChatModel: null,
    suggestedEmbeddingModel: 'voyage-3',
  },
  {
    slug: 'google',
    name: 'Google AI',
    providerType: 'openai-compatible',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnvVars: ['GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    isLocal: false,
    suggestedDefaultChatModel: 'gemini-2.0-flash',
    suggestedEmbeddingModel: 'text-embedding-004',
  },
  {
    slug: 'mistral',
    name: 'Mistral AI',
    providerType: 'openai-compatible',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnvVars: ['MISTRAL_API_KEY'],
    isLocal: false,
    suggestedDefaultChatModel: 'mistral-large-latest',
    suggestedEmbeddingModel: 'mistral-embed',
  },
  {
    slug: 'groq',
    name: 'Groq',
    providerType: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVars: ['GROQ_API_KEY'],
    isLocal: false,
    suggestedDefaultChatModel: 'llama-3.3-70b-versatile',
    suggestedEmbeddingModel: null,
  },
  {
    slug: 'together',
    name: 'Together AI',
    providerType: 'openai-compatible',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    apiKeyEnvVars: ['TOGETHER_API_KEY'],
    isLocal: false,
    suggestedDefaultChatModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    suggestedEmbeddingModel: null,
  },
  {
    slug: 'fireworks',
    name: 'Fireworks AI',
    providerType: 'openai-compatible',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnvVars: ['FIREWORKS_API_KEY'],
    isLocal: false,
    suggestedDefaultChatModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    suggestedEmbeddingModel: null,
  },
  {
    slug: 'ollama-local',
    name: 'Ollama (Local)',
    providerType: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    apiKeyEnvVars: [],
    isLocal: true,
    suggestedDefaultChatModel: 'llama3.2',
    suggestedEmbeddingModel: 'nomic-embed-text',
  },
] as const;

/**
 * Find which env-var name a known provider has set in the current
 * process. Returns the first match from `apiKeyEnvVars` whose
 * `process.env[name]` is a non-empty string, or `null` if none.
 *
 * Never returns the env-var *value*. The setup wizard surfaces a
 * boolean to the browser; the secret stays server-side.
 */
export function detectApiKeyEnvVar(provider: KnownProvider): string | null {
  for (const envVar of provider.apiKeyEnvVars) {
    const value = process.env[envVar];
    if (typeof value === 'string' && value.length > 0) {
      return envVar;
    }
  }
  return null;
}
