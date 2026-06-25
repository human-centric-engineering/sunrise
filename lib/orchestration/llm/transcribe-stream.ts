/**
 * Streaming-transcription seam.
 *
 * Bridges the optional `LlmProvider.transcribeStream` capability with the
 * universally-available batch `transcribe`, so callers can consume a single
 * `AsyncIterable<TranscribeChunk>` regardless of whether the resolved
 * provider streams natively. This is the platform-side half of the
 * streaming-STT feature; the client transport + mic layer are a separate
 * follow-up (see issue #308 / `.context/orchestration/llm-providers.md`).
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import type {
  TranscribeAudio,
  TranscribeChunk,
  TranscribeOptions,
} from '@/lib/orchestration/llm/types';

/** Thrown when a provider supports neither streaming nor batch transcription. */
function transcriptionUnsupported(): ProviderError {
  return new ProviderError('Provider does not support transcription', {
    code: 'not_supported',
    retriable: false,
  });
}

/**
 * Adapt a batch `transcribe()` call into a degenerate stream: one `final`
 * chunk carrying the full transcript, then a terminal `done` carrying
 * `audioSeconds` for billing. This is the cross-provider fallback for
 * providers without native streaming STT, and lets every batch-capable
 * provider satisfy the streaming contract without word-level interim text.
 *
 * Throws `not_supported` if the provider has no `transcribe` method.
 */
export async function* batchTranscribeAsStream(
  provider: Pick<LlmProvider, 'transcribe'>,
  audio: TranscribeAudio,
  options: TranscribeOptions
): AsyncIterable<TranscribeChunk> {
  if (!provider.transcribe) throw transcriptionUnsupported();

  const result = await provider.transcribe(audio, options);
  yield {
    type: 'final',
    text: result.text,
    ...(result.language !== undefined ? { language: result.language } : {}),
  };
  // durationMs is 0 when the provider doesn't report duration. Clamp any
  // non-finite/negative value to 0 here so the `done` chunk always honours
  // the "audioSeconds 0 = unknown" contract, rather than leaking NaN to
  // consumers if a provider's transcribe() violates the typed `number`.
  const audioSeconds =
    Number.isFinite(result.durationMs) && result.durationMs > 0 ? result.durationMs / 1000 : 0;
  yield { type: 'done', audioSeconds, model: result.model };
}

/**
 * Resolve the best available streaming path for `provider`:
 *  1. native `transcribeStream` when implemented (true interim transcripts);
 *  2. otherwise the batch → single-`final` fallback via
 *     {@link batchTranscribeAsStream};
 *  3. `not_supported` when the provider has neither method.
 *
 * Returns an `AsyncIterable<TranscribeChunk>` — the `not_supported` error
 * surfaces on first iteration (consistent with a consumer's `for await`
 * loop), not synchronously at call time.
 */
export async function* streamTranscription(
  provider: LlmProvider,
  audio: TranscribeAudio,
  options: TranscribeOptions
): AsyncIterable<TranscribeChunk> {
  if (provider.transcribeStream) {
    yield* provider.transcribeStream(audio, options);
    return;
  }
  if (provider.transcribe) {
    yield* batchTranscribeAsStream(provider, audio, options);
    return;
  }
  throw transcriptionUnsupported();
}
