/**
 * OpenAiCompatibleProvider.testKey — testing an org's key on a host Sunrise
 * knows nothing else about (§137 t-1056).
 *
 * The SDK is mocked per client, keyed by the API key it was built with, so a
 * test can say how the host answers the submitted key and how it answers a key
 * known to be wrong. The shapes follow what real hosts answered a made-up key
 * on 2026-11-19: OpenAI (401), Mistral (401) and Groq (403) refuse it on their
 * model list, Gemini and xAI with 400; OpenRouter serves its model list to
 * anyone (200) and refuses it on chat (401); Perplexity has no model list
 * (404) and refuses it on chat (401).
 *
 * @see lib/orchestration/llm/openai-compatible.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** How the host answers one key: per call, a status to fail with, or success. */
interface HostAnswers {
  /** `'not-a-list'`: a 200 whose body is not a model list. */
  list: number | 'ok' | 'not-a-list' | Error;
  chat: number | 'ok' | Error;
}

const answers = vi.hoisted((): { byKey: Map<string, HostAnswers> } => ({ byKey: new Map() }));
const calls = vi.hoisted((): { log: string[]; timeouts: unknown[] } => ({
  log: [],
  timeouts: [],
}));

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
    if (outcome === 'not-a-list') return {};
    return call === 'list' ? { data: [{ id: 'model-a' }] } : { choices: [] };
  };
  class MockOpenAI {
    public models: { list: () => Promise<unknown> };
    public chat: { completions: { create: (body: unknown) => Promise<unknown> } };
    public embeddings = { create: vi.fn() };
    constructor(opts: { apiKey: string; timeout?: unknown }) {
      calls.timeouts.push(opts.timeout);
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
  calls.timeouts = [];
});

/** The calls made, in a stable order: each pair is sent together. */
const made = () => [...calls.log].sort();

describe('OpenAiCompatibleProvider.testKey', () => {
  it('passes on a host that checks keys on its model list, sending no chat request (OpenAI)', async () => {
    host({ list: 'ok', chat: 'ok' }, { list: 401, chat: 401 });

    const result = await provider().testKey();

    expect(result).toEqual({ ok: true, models: ['model-a'] });
    expect(made()).toEqual([`list:${KEY}`, `list:${WRONG}`]);
  });

  it.each([400, 403])(
    'passes on a host that fails a wrong key on its model list with %i (Gemini, xAI, Groq)',
    async (status) => {
      host({ list: 'ok', chat: 400 }, { list: status, chat: status });

      const result = await provider().testKey();

      expect(result).toEqual({ ok: true, models: ['model-a'] });
      expect(made()).toEqual([`list:${KEY}`, `list:${WRONG}`]);
    }
  );

  it.each([429, 503])(
    'does not take a wrong key’s %i on the model list as a check, and asks the chat endpoint',
    async (status) => {
      host({ list: 'ok', chat: 400 }, { list: status, chat: 401 });

      const result = await provider().testKey();

      expect(result.ok).toBe(true);
      expect(made()).toContain(`chat:${WRONG}`);
    }
  );

  it('on a host with no model list, decides on the chat endpoint (Perplexity)', async () => {
    host({ list: 404, chat: 400 }, { list: 404, chat: 401 });
    await expect(provider().testKey()).resolves.toEqual({ ok: true, models: [] });

    host({ list: 404, chat: 401 }, { list: 404, chat: 401 });
    await expect(provider().testKey()).resolves.toMatchObject({ ok: false });
  });

  it('fails a key a host refuses as it refuses a wrong one, and says so (a mistyped Gemini key)', async () => {
    host({ list: 400, chat: 400 }, { list: 400, chat: 400 });

    const result = await provider().testKey();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^The provider answered this key as it answers a wrong one: 400/);
  });

  it('passes a key the model list refuses but chat accepts (an OpenAI project key without model read)', async () => {
    host({ list: 403, chat: 400 }, { list: 401, chat: 401 });

    const result = await provider().testKey();

    expect(result).toEqual({ ok: true, models: [] });
  });

  it('goes on to chat when the model list answers with something that is not a list', async () => {
    host({ list: 'not-a-list', chat: 400 }, { list: 'not-a-list', chat: 401 });

    await expect(provider().testKey()).resolves.toMatchObject({ ok: true });
  });

  it('holds every call to a short timeout, not the provider’s two minutes', async () => {
    host({ list: 'ok', chat: 'ok' }, { list: 401, chat: 401 });

    await provider().testKey();

    // The provider's own client, then the two the test builds.
    expect(calls.timeouts.slice(1)).toEqual([15_000, 15_000]);
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
    expect(made()).toEqual([`chat:${KEY}`, `chat:${WRONG}`, `list:${KEY}`, `list:${WRONG}`]);
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

  it('fails with the network error, not "cannot be tested", when the wrong key’s chat gets no answer', async () => {
    host({ list: 'ok', chat: 400 }, { list: 'ok', chat: new Error('socket hang up') });

    const result = await provider().testKey();

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/socket hang up/) });
  });

  it('fails when the chat check gets no answer at all', async () => {
    host({ list: 'ok', chat: new Error('connect ECONNREFUSED') }, { list: 'ok', chat: 401 });

    const result = await provider().testKey();

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/ECONNREFUSED/) });
  });

  it('fails when the host cannot be reached', async () => {
    const down = new Error('getaddrinfo ENOTFOUND');
    host({ list: down, chat: down }, { list: down, chat: down });

    const result = await provider().testKey();

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/ENOTFOUND/) });
  });
});
