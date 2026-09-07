/**
 * The in-flight Proxy's method allowlist.
 *
 * These cover the property the disposition map exists to hold: everything
 * `getProvider` hands back has been classified, and an operation nobody
 * classified cannot reach a vendor quietly.
 *
 * The compile-time half of that guarantee is not testable from here — it is a
 * `Record<ProviderMethodName, …>` keyed off `LlmProvider` itself, so adding a
 * method to the interface without classifying it is a type error, not a
 * runtime one. Verified by adding a sentinel method to `LlmProvider` and
 * confirming `tsc` rejects `METHOD_DISPOSITION`; there is no way to assert
 * that from a passing test file, and pretending otherwise would be a test
 * that cannot fail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';

vi.mock('@/lib/db/client', () => ({
  prisma: { aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() } },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { logger } = await import('@/lib/logging');
const { getProvider, registerProviderInstance, clearCache } =
  await import('@/lib/orchestration/llm/provider-manager');
const { getInFlightCounts, __resetInFlightCountersForTests } =
  await import('@/lib/orchestration/llm/in-flight-counter');

/**
 * A provider that reports the in-flight count from *inside* each call. That
 * is the only honest way to assert tracking: `track()` decrements in a
 * `finally`, so by the time the caller sees the result the count is back to
 * zero and an assertion made there passes whether or not anything wrapped it.
 */
function makeProbe(overrides: Partial<Record<string, unknown>> = {}): {
  provider: LlmProvider;
  seen: number[];
} {
  const seen: number[] = [];
  const record = (): void => {
    seen.push(getInFlightCounts().find((c) => c.provider === 'probe')?.inFlight ?? 0);
  };
  const provider = {
    name: 'probe',
    isLocal: false,
    chat: vi.fn(async () => {
      record();
      return { content: '', model: 'm', usage: { inputTokens: 0, outputTokens: 0 } };
    }),
    // eslint-disable-next-line require-yield
    chatStream: async function* () {
      record();
    },
    embed: vi.fn(async () => {
      record();
      return [0];
    }),
    listModels: vi.fn(async () => []),
    testConnection: vi.fn(async () => ({ ok: true, models: [] })),
    transcribe: vi.fn(async () => {
      record();
      return { text: '', durationMs: 0, model: 'm' };
    }),
    transcribeStream: async function* () {
      record();
      yield { type: 'final' as const, text: '' };
    },
    ...overrides,
  } as unknown as LlmProvider;
  return { provider, seen };
}

beforeEach(() => {
  clearCache();
  __resetInFlightCountersForTests();
  vi.clearAllMocks();
});

describe('the Proxy counts every classified vendor call', () => {
  it('counts transcribeStream, which used to fall through uncounted', async () => {
    // Arrange
    const { provider, seen } = makeProbe();
    registerProviderInstance('probe', provider);

    // Act: drain the stream so the iterator actually runs
    const resolved = await getProvider('probe');
    for await (const _chunk of resolved.transcribeStream!(new Uint8Array(), { model: 'm' })) {
      // consume
    }

    // Assert: the count was held while the stream was producing. Against the
    // pre-change code this is [0] — transcribeStream was in neither method
    // set, so it was returned `fn.bind(target)` and nothing counted it.
    expect(seen).toEqual([1]);
  });

  it.each([
    ['chat', (p: LlmProvider) => p.chat([], { model: 'm' })],
    ['embed', (p: LlmProvider) => p.embed('x')],
    ['transcribe', (p: LlmProvider) => p.transcribe!(new Uint8Array(), { model: 'm' })],
  ])('counts %s', async (_name, call) => {
    // Arrange
    const { provider, seen } = makeProbe();
    registerProviderInstance('probe', provider);

    // Act
    await call(await getProvider('probe'));

    // Assert
    expect(seen).toEqual([1]);
  });

  it('does not count the admin-metadata methods', async () => {
    // Arrange
    const { provider } = makeProbe();
    registerProviderInstance('probe', provider);
    const resolved = await getProvider('probe');

    // Act
    await resolved.listModels();
    await resolved.testConnection();

    // Assert: passthrough is a decision, not an omission — nothing is counted,
    // and nothing throws either.
    expect(getInFlightCounts()).toEqual([]);
  });
});

describe('an unclassified method fails closed', () => {
  it('throws on access to a method that is not on the LlmProvider contract', async () => {
    // Arrange: the synthetic new vendor-reaching operation — exactly what a
    // fork adds to its own provider class without touching the interface.
    const rerank = vi.fn(async () => ['a']);
    const { provider } = makeProbe({ rerank });
    registerProviderInstance('probe', provider);
    const resolved = await getProvider('probe');

    // Act + Assert: it fails at ACCESS, so feature detection fails too.
    expect(() => (resolved as unknown as { rerank: unknown }).rerank).toThrow(
      /not on the LlmProvider contract/
    );
    expect(rerank).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Refusing an unclassified method on a provider instance',
      undefined,
      { provider: 'probe', method: 'rerank' }
    );
  });

  it('still forwards host machinery, so observers do not trip the guard', async () => {
    // Arrange
    const { provider } = makeProbe();
    registerProviderInstance('probe', provider);
    const resolved = await getProvider('probe');

    // Act + Assert: `constructor` and Object.prototype members are reached by
    // test runners, structured logging and util.inspect. Refusing them would
    // fail on the observer rather than on the thing observed.
    expect(() => resolved.constructor).not.toThrow();
    expect(() => Object.prototype.toString.call(resolved)).not.toThrow();
    // Reaching `toString` THROUGH the proxy is the thing under test; calling it
    // is not, and the base-to-string lint rule objects to the call.
    expect(() => (resolved as unknown as { toString: unknown }).toString).not.toThrow();
    expect(Object.prototype.hasOwnProperty.call(resolved, 'name')).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('passes non-function properties through untouched', async () => {
    // Arrange
    const { provider } = makeProbe();
    registerProviderInstance('probe', provider);

    // Act
    const resolved = await getProvider('probe');

    // Assert: the guard is about methods; `name`/`isLocal` are data.
    expect(resolved.name).toBe('probe');
    expect(resolved.isLocal).toBe(false);
  });
});
