/**
 * Capability Inference
 *
 * Maps a (providerSlug, modelId) pair to a single coarse capability —
 * what kind of model it is from the perspective of the test panel.
 * Used by the View Models endpoint to enrich live SDK output for
 * models that aren't in the curated `AiProviderModel` matrix yet, so
 * the UI can show capability badges and the per-row Test button can
 * route by capability instead of blindly calling `chat.completions`
 * (which 404s for embedding / image / audio / reasoning models).
 *
 * Inference is conservative: only patterns that are strongly tied to
 * vendor naming conventions return a non-`'unknown'` value. When in
 * doubt, return `'unknown'` and let the matrix carry the truth — the
 * panel disables the Test button on `'unknown'` entries with a
 * tooltip explaining why.
 *
 * Why this lives in `lib/orchestration/llm/` and not `lib/llm/`:
 * matches the rest of the orchestration LLM helpers (provider
 * manager, settings resolver, known-providers).
 */

export type Capability =
  | 'chat'
  | 'reasoning'
  | 'embedding'
  | 'image'
  | 'audio'
  | 'moderation'
  | 'unknown';

/**
 * Infer the single coarse capability for a model id, scoped to the
 * provider's naming conventions. Returns `'unknown'` when no rule
 * fires.
 *
 * Provider-specific rules:
 *
 *   - **OpenAI** has the broadest taxonomy by far — its catalogue
 *     mixes chat, reasoning (o1/o3/o4 series, served via
 *     `/v1/responses`), embeddings, image (`dall-e-*`, `gpt-image-*`),
 *     audio transcription (`whisper-*`) and synthesis (`tts-*`),
 *     and moderation. Match all of these.
 *
 *   - **Voyage** is embeddings-only — `voyage-*` and `rerank-*` both
 *     return `'embedding'` (rerank uses the same /embeddings-style
 *     surface for testing purposes; the real distinction is exposed
 *     elsewhere).
 *
 *   - **Cohere, Mistral, Groq, Together, Fireworks, Anthropic,
 *     Google, Ollama** all expose chat-only catalogues from the
 *     panel's perspective. Default to `'chat'` for any model id we
 *     can't classify more precisely (still allows the Test button to
 *     be useful).
 *
 *   - Any provider not listed above falls through to `'unknown'`
 *     when no pattern matches — safer than asserting `'chat'`.
 */
export function inferCapability(providerSlug: string, modelId: string): Capability {
  const slug = providerSlug.toLowerCase();
  const id = modelId.toLowerCase();

  if (slug === 'openai' || slug === 'azure-openai') {
    if (id.startsWith('text-embedding-') || id.includes('embedding')) return 'embedding';
    if (id.startsWith('dall-e-') || id.startsWith('gpt-image-')) return 'image';
    if (id.startsWith('whisper-')) return 'audio';
    if (id.startsWith('tts-')) return 'audio';
    if (id.includes('moderation')) return 'moderation';
    // Reasoning series uses /v1/responses, not /v1/chat/completions —
    // testing one as chat is the bug that motivated this whole rework.
    // Anchor on hyphen/word boundary so `o3-pro-2025-06-10` matches
    // but `gpt-o3-mini` (hypothetical chat alias) wouldn't be a false
    // positive.
    if (/^o[134](-|$)/.test(id)) return 'reasoning';
    if (id.startsWith('gpt-') || id.startsWith('chatgpt-')) return 'chat';
    return 'unknown';
  }

  if (slug === 'voyage' || slug === 'voyage-ai') {
    if (id.startsWith('voyage-') || id.startsWith('rerank-')) return 'embedding';
    return 'unknown';
  }

  if (slug === 'cohere') {
    if (id.startsWith('embed-') || id.startsWith('rerank-')) return 'embedding';
    if (id.startsWith('command-') || id.startsWith('c4ai-')) return 'chat';
    return 'unknown';
  }

  if (slug === 'google' || slug === 'google-ai' || slug === 'gemini') {
    if (id.startsWith('text-embedding-') || id.startsWith('gemini-embedding-')) return 'embedding';
    if (id.includes('imagen')) return 'image';
    if (id.startsWith('gemini-')) return 'chat';
    return 'unknown';
  }

  if (slug === 'mistral') {
    if (id.includes('embed')) return 'embedding';
    return 'chat';
  }

  // Anthropic, Groq, Together, Fireworks, Ollama and other
  // chat-centric vendors: assume chat unless the id contains
  // 'embed' (defensive, in case a vendor adds embeddings later) or
  // matches one of the Whisper-family audio model patterns that
  // these OpenAI-API-compatible vendors serve through
  // `/v1/audio/transcriptions`. Limited to providers whose backing
  // class (OpenAiCompatibleProvider) actually implements transcribe();
  // adding Deepgram/AssemblyAI here would mislead operators because
  // the runtime would silently skip those rows.
  if (
    slug === 'anthropic' ||
    slug === 'groq' ||
    slug === 'together' ||
    slug === 'fireworks' ||
    slug === 'ollama' ||
    slug === 'openai-compatible'
  ) {
    if (id.includes('embed')) return 'embedding';
    if (slug !== 'anthropic' && /whisper/i.test(id)) return 'audio';
    return 'chat';
  }

  return 'unknown';
}
