/**
 * Unit tests for the streaming-transcription seam.
 *
 * Covers:
 *  - batchTranscribeAsStream: final (+language) then done with
 *    audioSeconds = durationMs/1000 and the model echo; language omitted
 *    when the provider doesn't report it; audioSeconds 0 when duration is 0;
 *    throws not_supported when the provider can't transcribe.
 *  - streamTranscription: prefers native transcribeStream; falls back to the
 *    batch adapter; throws not_supported (on iteration) when neither exists.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  batchTranscribeAsStream,
  streamTranscription,
} from '@/lib/orchestration/llm/transcribe-stream';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import type {
  TranscribeChunk,
  TranscribeOptions,
  TranscribeResponse,
} from '@/lib/orchestration/llm/types';

const AUDIO = new Uint8Array([1, 2, 3]);
const OPTS: TranscribeOptions = { model: 'whisper-1' };

async function collect(stream: AsyncIterable<TranscribeChunk>): Promise<TranscribeChunk[]> {
  const out: TranscribeChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function transcribeOnly(response: TranscribeResponse): Pick<LlmProvider, 'transcribe'> {
  return { transcribe: vi.fn(async () => response) };
}

describe('batchTranscribeAsStream', () => {
  it('yields a final chunk then a done chunk with audioSeconds and model', async () => {
    const provider = transcribeOnly({
      text: 'hello world',
      durationMs: 4500,
      language: 'en',
      model: 'whisper-1',
    });

    const chunks = await collect(batchTranscribeAsStream(provider, AUDIO, OPTS));

    expect(chunks).toEqual([
      { type: 'final', text: 'hello world', language: 'en' },
      { type: 'done', audioSeconds: 4.5, model: 'whisper-1' },
    ]);
    expect(provider.transcribe).toHaveBeenCalledWith(AUDIO, OPTS);
  });

  it('omits language on the final chunk when the provider does not report it', async () => {
    const provider = transcribeOnly({ text: 'hi', durationMs: 1000, model: 'whisper-1' });

    const chunks = await collect(batchTranscribeAsStream(provider, AUDIO, OPTS));

    expect(chunks[0]).toEqual({ type: 'final', text: 'hi' });
    expect(chunks[0]).not.toHaveProperty('language');
  });

  it('reports audioSeconds 0 when the provider does not report duration', async () => {
    const provider = transcribeOnly({ text: 'hi', durationMs: 0, model: 'whisper-1' });

    const chunks = await collect(batchTranscribeAsStream(provider, AUDIO, OPTS));

    expect(chunks[1]).toEqual({ type: 'done', audioSeconds: 0, model: 'whisper-1' });
  });

  it('throws not_supported when the provider has no transcribe method', async () => {
    await expect(collect(batchTranscribeAsStream({}, AUDIO, OPTS))).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'not_supported',
    });
  });
});

describe('streamTranscription', () => {
  it('delegates to native transcribeStream when implemented and does not call transcribe', async () => {
    const native: TranscribeChunk[] = [
      { type: 'partial', text: 'hel' },
      { type: 'final', text: 'hello' },
      { type: 'done', audioSeconds: 2, model: 'deepgram-nova' },
    ];
    const transcribe = vi.fn();
    const provider = {
      transcribe,
      transcribeStream: vi.fn(async function* () {
        yield* native;
      }),
    } as unknown as LlmProvider;

    const chunks = await collect(streamTranscription(provider, AUDIO, OPTS));

    expect(chunks).toEqual(native);
    expect(provider.transcribeStream).toHaveBeenCalledWith(AUDIO, OPTS);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('falls back to the batch adapter when only transcribe is available', async () => {
    const provider = {
      transcribe: vi.fn(async () => ({
        text: 'batch text',
        durationMs: 3000,
        model: 'whisper-1',
      })),
    } as unknown as LlmProvider;

    const chunks = await collect(streamTranscription(provider, AUDIO, OPTS));

    expect(chunks).toEqual([
      { type: 'final', text: 'batch text' },
      { type: 'done', audioSeconds: 3, model: 'whisper-1' },
    ]);
  });

  it('throws not_supported on iteration when neither method exists', async () => {
    const provider = {} as unknown as LlmProvider;

    await expect(collect(streamTranscription(provider, AUDIO, OPTS))).rejects.toBeInstanceOf(
      ProviderError
    );
  });
});
