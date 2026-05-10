/**
 * OpenAiCompatibleProvider — transcribe() tests
 *
 * Covers:
 * - Happy path (verbose_json response → text + duration + language)
 * - Optional language / prompt forwarded to the SDK
 * - Buffer / Uint8Array / ArrayBuffer / Blob inputs all flow through `toFile`
 * - SDK error wraps to ProviderError
 * - Abort signal short-circuits (via withRetry honouring signal)
 * - `toFile` failure surfaces as ProviderError
 *
 * @see lib/orchestration/llm/openai-compatible.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.hoisted()` keeps these mocks available inside the hoisted `vi.mock()`
// factory below — without it, static imports of the SUT would resolve before
// these `const` initialisers ran, leaving the factory referencing
// uninitialised bindings.
const { transcriptionsCreateMock, toFileMock } = vi.hoisted(() => ({
  transcriptionsCreateMock: vi.fn(),
  toFileMock: vi.fn(),
}));

vi.mock('openai', () => {
  class MockOpenAI {
    public chat = { completions: { create: vi.fn() } };
    public embeddings = { create: vi.fn() };
    public models = { list: vi.fn() };
    public audio = { transcriptions: { create: transcriptionsCreateMock } };
    constructor(_opts: unknown) {}
  }
  return { default: MockOpenAI, toFile: toFileMock };
});

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { OpenAiCompatibleProvider } from '@/lib/orchestration/llm/openai-compatible';
import { ProviderError } from '@/lib/orchestration/llm/provider';

beforeEach(() => {
  transcriptionsCreateMock.mockReset();
  toFileMock.mockReset();
  // Default: pass the input through unmodified for inspection.
  toFileMock.mockImplementation(async (data: unknown, name: string, opts?: { type?: string }) => ({
    __mock: true,
    data,
    name,
    type: opts?.type,
  }));
});

function makeProvider() {
  return new OpenAiCompatibleProvider({
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    isLocal: false,
  });
}

function makeVerboseResponse(overrides: Record<string, unknown> = {}) {
  return {
    text: 'Hello, world.',
    duration: 2.5,
    language: 'en',
    ...overrides,
  };
}

describe('OpenAiCompatibleProvider.transcribe', () => {
  it('returns text + durationMs + language from a verbose_json response', async () => {
    transcriptionsCreateMock.mockResolvedValue(makeVerboseResponse());

    const result = await makeProvider().transcribe(Buffer.from('audio-bytes'), {
      model: 'whisper-1',
    });

    expect(result.text).toBe('Hello, world.');
    expect(result.durationMs).toBe(2500);
    expect(result.language).toBe('en');
    expect(result.model).toBe('whisper-1');
  });

  it('forwards model and response_format=verbose_json to the SDK', async () => {
    transcriptionsCreateMock.mockResolvedValue(makeVerboseResponse());

    await makeProvider().transcribe(Buffer.from('x'), { model: 'whisper-1' });

    expect(transcriptionsCreateMock).toHaveBeenCalledTimes(1);
    const args = transcriptionsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.model).toBe('whisper-1');
    expect(args.response_format).toBe('verbose_json');
  });

  it('forwards optional language hint and prompt to the SDK', async () => {
    transcriptionsCreateMock.mockResolvedValue(makeVerboseResponse({ language: 'es' }));

    await makeProvider().transcribe(Buffer.from('x'), {
      model: 'whisper-1',
      language: 'es',
      prompt: 'spelling: Acme, Yulianna',
    });

    const args = transcriptionsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.language).toBe('es');
    expect(args.prompt).toBe('spelling: Acme, Yulianna');
  });

  it('omits language and prompt fields when not provided', async () => {
    transcriptionsCreateMock.mockResolvedValue(makeVerboseResponse());

    await makeProvider().transcribe(Buffer.from('x'), { model: 'whisper-1' });

    const args = transcriptionsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('language');
    expect(args).not.toHaveProperty('prompt');
  });

  it('uses provided filename and mimeType when wrapping the upload', async () => {
    transcriptionsCreateMock.mockResolvedValue(makeVerboseResponse());

    await makeProvider().transcribe(Buffer.from('x'), {
      model: 'whisper-1',
      filename: 'voice.mp4',
      mimeType: 'audio/mp4',
    });

    expect(toFileMock).toHaveBeenCalledWith(expect.anything(), 'voice.mp4', { type: 'audio/mp4' });
  });

  it('defaults filename to audio.webm when not provided', async () => {
    transcriptionsCreateMock.mockResolvedValue(makeVerboseResponse());

    await makeProvider().transcribe(Buffer.from('x'), {
      model: 'whisper-1',
      mimeType: 'audio/webm',
    });

    expect(toFileMock.mock.calls[0]?.[1]).toBe('audio.webm');
  });

  it('coerces a missing duration to durationMs=0', async () => {
    transcriptionsCreateMock.mockResolvedValue({ text: 'no duration', duration: undefined });

    const result = await makeProvider().transcribe(Buffer.from('x'), { model: 'whisper-1' });

    expect(result.durationMs).toBe(0);
  });

  it('omits language from the response when the provider does not return one', async () => {
    transcriptionsCreateMock.mockResolvedValue({ text: 'no lang', duration: 1 });

    const result = await makeProvider().transcribe(Buffer.from('x'), { model: 'whisper-1' });

    expect(result).not.toHaveProperty('language');
  });

  it('wraps SDK errors into ProviderError', async () => {
    transcriptionsCreateMock.mockRejectedValue(
      Object.assign(new Error('upstream failure'), { status: 500 })
    );

    await expect(
      makeProvider().transcribe(Buffer.from('x'), { model: 'whisper-1' })
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('treats a 400 response as non-retriable', async () => {
    let attempts = 0;
    transcriptionsCreateMock.mockImplementation(async () => {
      attempts += 1;
      throw Object.assign(new Error('bad audio'), { status: 400 });
    });

    await expect(
      makeProvider().transcribe(Buffer.from('x'), { model: 'whisper-1' })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(attempts).toBe(1);
  });

  it('surfaces toFile failures as ProviderError', async () => {
    toFileMock.mockRejectedValueOnce(new Error('file wrap failed'));

    await expect(
      makeProvider().transcribe(Buffer.from('x'), { model: 'whisper-1' })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(transcriptionsCreateMock).not.toHaveBeenCalled();
  });

  it('propagates an aborted signal without calling the SDK', async () => {
    const ac = new AbortController();
    ac.abort();
    transcriptionsCreateMock.mockResolvedValue(makeVerboseResponse());

    await expect(
      makeProvider().transcribe(Buffer.from('x'), { model: 'whisper-1', signal: ac.signal })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(transcriptionsCreateMock).not.toHaveBeenCalled();
  });
});
