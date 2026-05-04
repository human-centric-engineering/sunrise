/**
 * Per-provider tokenisation
 *
 * Replaces the chars / 3.5 heuristic with provider-aware token counts.
 * The shape of the problem:
 *
 *   - LLMs split text into tokens, not characters. The mapping is dense
 *     for English prose (~4 chars/token), much denser for code, and
 *     much sparser for non-English / CJK text (~1–2 chars/token).
 *   - Each provider family ships its own tokeniser. OpenAI and Anthropic
 *     and Google all disagree on the same string by 10–30%.
 *   - Underestimating tokens before a chat call risks a hard
 *     context-window rejection from the provider. Overestimating drops
 *     more history than we needed to.
 *
 * Design constraints:
 *
 *   1. Synchronous + local. The truncation path runs on every chat
 *      turn and must not make a network call. Anthropic's network
 *      `count_tokens` endpoint and Google's `countTokens` SDK are
 *      therefore out — we use a local approximator for those.
 *   2. No WASM. `gpt-tokenizer` is pure JS so it works in any Node
 *      runtime Sunrise targets without bundler/CSP gymnastics.
 *   3. Honest about precision. Only OpenAI gets exact counts; everyone
 *      else gets `o200k_base` (the most non-English-friendly OpenAI
 *      encoding) plus a small calibration multiplier, so the estimate
 *      is conservatively high — meaning we drop a little more history
 *      than strictly necessary, never less.
 *
 * The calibration multipliers are starting points based on published
 * tokeniser-density studies and Anthropic's own framing-overhead notes.
 * They are conservative on purpose — over-estimating tokens is the
 * safe failure mode (we truncate slightly early rather than overflow
 * the context window). To re-calibrate, run a corpus-based measurement
 * comparing the value here against `LlmResponse.usage.inputTokens` from
 * each provider; see `.context/orchestration/llm-providers.md` for the
 * methodology.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';

import { getModel } from '@/lib/orchestration/llm/model-registry';

/** Public tokeniser contract. Synchronous, no network, no failures. */
export interface Tokeniser {
  /** Stable identifier — used in logs / tests / docs. */
  readonly id: string;
  /** Whether this tokeniser produces exact counts for the target family. */
  readonly exact: boolean;
  /** Count tokens in a single string. */
  count(text: string): number;
}

/**
 * Calibration multipliers per provider family.
 *
 * Applied on top of the `o200k_base` byte-pair count. Values rounded
 * up to keep estimates conservative.
 *
 *   - `1.10` for Anthropic / Gemini — modern BPE tokenisers similar to
 *     o200k but with provider-specific framing overhead per turn.
 *   - `1.05` for Llama-family (Together / Fireworks / Groq / Ollama)
 *     — Llama 3's 128k-vocab tokeniser is close to o200k_base in density.
 *   - Heuristic fallback unchanged at `3.5 chars/token` for unknown
 *     models (defensive only — the registry should always know the
 *     model in production).
 */
const ANTHROPIC_MULTIPLIER = 1.1;
const GEMINI_MULTIPLIER = 1.1;
const LLAMA_MULTIPLIER = 1.05;

/** Average characters per token used by the heuristic fallback. */
const HEURISTIC_CHARS_PER_TOKEN = 3.5;

/**
 * Decide whether an OpenAI model uses `o200k_base` (gpt-4o, o1, o3, o4,
 * gpt-4.1) or `cl100k_base` (gpt-4, gpt-3.5). Modern models are the
 * default; legacy ids fall through to cl100k.
 */
function isLegacyOpenAi(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    id.startsWith('gpt-4-') || id === 'gpt-4' || id.includes('gpt-3.5') || id.includes('davinci')
  );
}

/**
 * Match a tokeniser by model-id naming convention.
 *
 * This is a defensive fallback for two cases the registry-by-provider
 * lookup cannot cover cleanly:
 *
 *   1. The registry has not yet been refreshed (race on first boot,
 *      or the model id was just added) so `getModel(id)` returns
 *      undefined.
 *   2. A custom-named provider config (e.g. "OpenAI Production") has
 *      its name surfaced as `ModelInfo.provider` for runtime-discovered
 *      ids — the lowercase comparison against `'openai'` would miss.
 *
 * Conservative on purpose — only the strongest naming conventions
 * (Claude, GPT, OpenAI o-series, Gemini, Llama) are captured. Anything
 * unrecognised falls through to the caller's default.
 */
function matchTokeniserByIdPattern(modelId: string): Tokeniser | null {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude-')) return anthropic;
  if (id.startsWith('gemini-') || id.startsWith('gemini/')) return gemini;
  if (id.startsWith('gpt-') || id === 'gpt-4' || id.includes('gpt-3.5')) {
    return isLegacyOpenAi(modelId) ? openAiLegacy : openAiModern;
  }
  if (/^o[134](-|$)/.test(id)) return openAiModern; // OpenAI reasoning models o1 / o3 / o4
  if (id.includes('llama') || id.includes('mistral') || id.includes('qwen')) return llama;
  return null;
}

class HeuristicTokeniser implements Tokeniser {
  readonly id = 'heuristic';
  readonly exact = false;

  count(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN);
  }
}

class OpenAiModernTokeniser implements Tokeniser {
  readonly id = 'openai-o200k';
  readonly exact = true;

  count(text: string): number {
    if (!text) return 0;
    return encodeO200k(text).length;
  }
}

class OpenAiLegacyTokeniser implements Tokeniser {
  readonly id = 'openai-cl100k';
  readonly exact = true;

  count(text: string): number {
    if (!text) return 0;
    return encodeCl100k(text).length;
  }
}

class CalibratedTokeniser implements Tokeniser {
  readonly exact = false;

  constructor(
    readonly id: string,
    private readonly multiplier: number
  ) {}

  count(text: string): number {
    if (!text) return 0;
    return Math.ceil(encodeO200k(text).length * this.multiplier);
  }
}

const heuristic = new HeuristicTokeniser();
const openAiModern = new OpenAiModernTokeniser();
const openAiLegacy = new OpenAiLegacyTokeniser();
const anthropic = new CalibratedTokeniser('anthropic-approx', ANTHROPIC_MULTIPLIER);
const gemini = new CalibratedTokeniser('gemini-approx', GEMINI_MULTIPLIER);
const llama = new CalibratedTokeniser('llama-approx', LLAMA_MULTIPLIER);

/**
 * Resolve a tokeniser for the given model id.
 *
 * Three layers, in priority order:
 *
 *   1. Registry-by-provider — if the model is in `getModel(id)` and
 *      its `provider` field matches a known family, route by that.
 *      This is the default path in production.
 *   2. Model-id pattern — if the registry is missing the entry, or
 *      the provider field is a custom human-readable label that
 *      doesn't match any known family, infer the family from the id
 *      (claude-*, gpt-*, gemini-*, llama-*, etc.). Defensive net.
 *   3. Llama-family approximator — final default for any modern BPE
 *      model not caught by the first two layers; underestimates by
 *      at most a few percent versus the truth, which is far better
 *      than the chars-only heuristic.
 *
 * Returns the heuristic tokeniser only when the caller passes a
 * missing / empty model id. Production callers should always supply
 * one.
 */
export function tokeniserForModel(modelId: string | undefined | null): Tokeniser {
  if (!modelId) return heuristic;

  const model = getModel(modelId);
  const provider = model?.provider?.toLowerCase();

  switch (provider) {
    case 'openai':
      return isLegacyOpenAi(modelId) ? openAiLegacy : openAiModern;
    case 'anthropic':
      return anthropic;
    case 'google':
    case 'gemini':
      return gemini;
    case 'together':
    case 'fireworks':
    case 'groq':
    case 'ollama':
    case 'lmstudio':
    case 'vllm':
    case 'meta-llama':
      return llama;
  }

  // Layer 2: pattern-match on the model id itself. Catches brand-new
  // ids before the registry has refreshed and custom-named provider
  // configs whose `provider` field doesn't match the family enum.
  const patternMatch = matchTokeniserByIdPattern(modelId);
  if (patternMatch) return patternMatch;

  // Layer 3: any modern frontier model uses a BPE-style tokeniser
  // close in density to o200k. The Llama approximator (multiplier
  // 1.05) is the safest default — slight over-count is the desired
  // failure mode.
  return llama;
}

/** Exported for tests + the calibration script. */
export const __tokenisers = { heuristic, openAiModern, openAiLegacy, anthropic, gemini, llama };
