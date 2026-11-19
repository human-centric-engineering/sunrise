/**
 * OpenAiCompatibleProvider.testKey — testing an org's key on a host Sunrise
 * knows nothing else about (§137 t-1056).
 *
 * The SDK is mocked per client, keyed by the API key it was built with, so a
 * test can say how the host answers the submitted key and how it answers a key
 * known to be wrong. The shapes follow what real hosts answered a made-up key
 * on 2026-11-19: OpenAI refuses it on its model list (401); OpenRouter serves
 * its model list to anyone (200) and refuses it on chat (401).
 *
 * @see lib/orchestration/llm/openai-compatible.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** How the host answers one key: per call, a status to fail with, or success. */
interface HostAnswers {
  list: number | 'ok' | Error;
  chat: number | 'ok' | Error;
}

const answers = vi.hoisted((): { byKey: Map<string, HostAnswers> } => ({ byKey: new Map() }));
const calls = vi.hoisted((): { log: string[] } => ({ log: [] }));

vi.mock('openai', () => {
  /** An SDK error carrying an HTTP status, as the real APIError does. */
  class StatusError extends Error {
    constructor(public status: number) {
      super(`${status} status code`);
    }
  }
  const answer = async (apiKey: string, call: 'list' | 'chat') => {
    calls.log.push(`${call}:${apiKey}`);
    const a = answers.byKey.get(apiKey) ?? answers.byKey.get('*');
    const outcome = a?.[call] ?? 'ok';
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'number') throw new StatusError(outcome);
    return call === 'list' ? { data: [{ id: 'model-a' }] } : { choices: [] };
  };
  class MockOpenAI {
    public models: { list: () => Promise<unknown> };
    public chat: { completions: { create: (body: unknown) => Promise<unknown> } };
    public embeddings = { create: vi.fn() };
    constructor(opts: { apiKey: string }) {
      this.models = { list: () => answer(opts.apiKey, 'list') };
      this.chat = { completions: { create: () => answer(opts.apiKey, 'chat') } };
    }
  }
  return { default: MockOpenAI, toFile: vi.fn() };
});

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { OpenAiCompatibleProvider } = await import('@/lib/orchestration/llm/openai-compatible');

const KEY = 'sk-org-key';
const WRONG = 'sunrise-key-check-not-a-real-key';

function provider() {
  return new OpenAiCompatibleProvider({
    name: 'host',
    baseUrl: 'https://llm.example.com/v1',
    apiKey: KEY,
    isLocal: false,
  });
}

function host(mine: HostAnswers, wrong: HostAnswers) {
  answers.byKey.set(KEY, mine);
  answers.byKey.set(WRONG, wrong);
}

beforeEach(() => {
  answers.byKey.clear();
  calls.log = [];
});

describe('OpenAiCompatibleProvider.testKey', () => {
  it('passes on a host that checks keys on its model list, sending no chat request (OpenAI)', async () => {
    host({ list: 'ok', chat: 'ok' }, { list: 401, chat: 401 });

    const result = await provider().testKey();

    expect(result).toEqual({ ok: true, models: ['model-a'] });
    expect(calls.log).toEqual([`list:${KEY}`, `list:${WRONG}`]);
  });

  it('fails a key the host refuses on its model list', async () => {
    host({ list: 401, chat: 401 }, { list: 401, chat: 401 });

    const result = await provider().testKey();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it('where the model list is open to any key, passes a key the chat endpoint accepts (OpenRouter)', async () => {
    // A good key gets past the key check and is refused for the empty request.
    host({ list: 'ok', chat: 400 }, { list: 'ok', chat: 401 });

    const result = await provider().testKey();

    expect(result).toEqual({ ok: true, models: ['model-a'] });
    expect(calls.log).toEqual([`list:${KEY}`, `list:${WRONG}`, `chat:${KEY}`, `chat:${WRONG}`]);
  });

  it.each([401, 403])(
    'where the model list is open to any key, fails a key the chat endpoint refuses with %i',
    async (status) => {
      host({ list: 'ok', chat: status }, { list: 'ok', chat: 401 });

      const result = await provider().testKey();

      expect(result).toMatchObject({ ok: false, models: [] });
      expect(result.error).toMatch(String(status));
    }
  );

  it('fails on a host that checks keys on neither call, since it cannot tell', async () => {
    host({ list: 'ok', chat: 400 }, { list: 'ok', chat: 400 });

    const result = await provider().testKey();

    expect(result).toEqual({
      ok: false,
      models: [],
      error:
        'This host checks keys on neither its model list nor its chat endpoint, so the key cannot be tested',
    });
  });

  it('fails when the chat check gets no answer at all', async () => {
    host({ list: 'ok', chat: new Error('connect ECONNREFUSED') }, { list: 'ok', chat: 401 });

    const result = await provider().testKey();

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/ECONNREFUSED/) });
  });

  it('fails when the model list cannot be reached', async () => {
    host({ list: new Error('getaddrinfo ENOTFOUND'), chat: 'ok' }, { list: 401, chat: 401 });

    const result = await provider().testKey();

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/ENOTFOUND/) });
    expect(calls.log).toEqual([`list:${KEY}`]);
  });
});
