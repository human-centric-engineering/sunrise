/**
 * Per-credential process state in the provider manager (§120 t-744).
 *
 * A credential resolver may give two orgs different keys for one provider row.
 * The client cache, the circuit breakers and the in-flight counter must then
 * key on (slug, identity) — a slug-keyed cache would hand org B the client
 * built with org A's key.
 *
 * @see lib/orchestration/llm/provider-manager.ts
 * @see lib/orchestration/llm/provider-credentials.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() } },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Every Anthropic client constructed, with the key it was built with. */
const clients = vi.hoisted(() => [] as { apiKey: unknown; create: ReturnType<typeof vi.fn> }[]);
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages: { create: ReturnType<typeof vi.fn> };
    constructor(opts: { apiKey?: unknown }) {
      const create = vi.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'm',
        stop_reason: 'end_turn',
      }));
      this.messages = { create };
      clients.push({ apiKey: opts.apiKey, create });
    }
  }
  return { default: MockAnthropic };
});

import { prisma } from '@/lib/db/client';
import {
  breakerKeyOf,
  clearCache,
  getProvider,
  getProviderWithFallbacks,
} from '@/lib/orchestration/llm/provider-manager';
import {
  registerProviderCredentialResolver,
  resetProviderCredentialResolver,
} from '@/lib/orchestration/llm/provider-credentials';
import {
  getBreaker,
  getCircuitBreakerStatusForProvider,
  resetAllBreakers,
  resetBreakersForProvider,
} from '@/lib/orchestration/llm/circuit-breaker';
import {
  __resetInFlightCountersForTests,
  getInFlightCounts,
} from '@/lib/orchestration/llm/in-flight-counter';
import { resetProviderEligibility } from '@/lib/orchestration/llm/provider-eligibility';
import { runAsOrg } from '@/lib/tenancy/context';

const ORG_A = 'cmorg00000000000000000orga';
const ORG_B = 'cmorg00000000000000000orgb';

const ROW = {
  id: 'p1',
  slug: 'anthropic',
  name: 'Anthropic',
  providerType: 'anthropic',
  baseUrl: null,
  apiKeyEnvVar: 'MANAGER_CRED_TEST_KEY',
  isLocal: false,
  isActive: true,
  timeoutMs: null,
  maxRetries: null,
  metadata: null,
  createdAt: new Date(),
};

/** Each org gets its own key, named by an identity that is not the key. */
function perOrgResolver() {
  registerProviderCredentialResolver((_config, { orgId }) => ({
    apiKey: `key-for-${orgId}`,
    identity: `org:${orgId}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  clients.length = 0;
  clearCache();
  resetAllBreakers();
  __resetInFlightCountersForTests();
  resetProviderCredentialResolver();
  resetProviderEligibility();
  vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(ROW as never);
  process.env.MANAGER_CRED_TEST_KEY = 'from-env';
});

afterEach(() => {
  resetProviderCredentialResolver();
  delete process.env.MANAGER_CRED_TEST_KEY;
});

describe('with nothing registered', () => {
  it('builds one client with the env key, shared by every org, keyed on the bare slug', async () => {
    const a = await runAsOrg(ORG_A, () => getProvider('anthropic'));
    const b = await runAsOrg(ORG_B, () => getProvider('anthropic'));

    expect(b).toBe(a);
    expect(clients.map((c) => c.apiKey)).toEqual(['from-env']);
    expect(breakerKeyOf(a)).toBe('anthropic');
  });
});

describe('with a resolver that gives each org its own key', () => {
  it("builds a client per org, and each org's call goes out on its own key", async () => {
    perOrgResolver();

    const a = await runAsOrg(ORG_A, () => getProvider('anthropic'));
    const b = await runAsOrg(ORG_B, () => getProvider('anthropic'));
    await runAsOrg(ORG_A, () => a.chat([{ role: 'user', content: 'hi' }], { model: 'm' }));
    await runAsOrg(ORG_B, () => b.chat([{ role: 'user', content: 'hi' }], { model: 'm' }));

    expect(b).not.toBe(a);
    const byKey = new Map(clients.map((c) => [c.apiKey, c.create]));
    expect([...byKey.keys()].sort()).toEqual([`key-for-${ORG_A}`, `key-for-${ORG_B}`]);
    // Exactly one call on each org's client: neither used the other's key.
    expect(byKey.get(`key-for-${ORG_A}`)).toHaveBeenCalledTimes(1);
    expect(byKey.get(`key-for-${ORG_B}`)).toHaveBeenCalledTimes(1);
  });

  it("reuses an org's client for that org, and reads the row once", async () => {
    perOrgResolver();

    const first = await runAsOrg(ORG_A, () => getProvider('anthropic'));
    const second = await runAsOrg(ORG_A, () => getProvider('anthropic'));

    expect(second).toBe(first);
    expect(clients).toHaveLength(1);
    expect(prisma.aiProviderConfig.findFirst).toHaveBeenCalledTimes(1);
  });

  it('keys the breaker per credential: one org tripping it does not pause the other', async () => {
    perOrgResolver();
    const a = await runAsOrg(ORG_A, () => getProvider('anthropic'));
    const b = await runAsOrg(ORG_B, () => getProvider('anthropic'));
    expect(breakerKeyOf(a)).toBe(`anthropic#org:${ORG_A}`);
    expect(breakerKeyOf(b)).toBe(`anthropic#org:${ORG_B}`);

    const breakerA = getBreaker(breakerKeyOf(a)!);
    for (let i = 0; i < 10; i++) breakerA.recordFailure();
    expect(breakerA.canAttempt()).toBe(false);

    // Org A has nothing to fall back to; org B is unaffected.
    await expect(
      runAsOrg(ORG_A, () => getProviderWithFallbacks('anthropic', []))
    ).rejects.toMatchObject({ code: 'all_providers_exhausted' });
    await expect(
      runAsOrg(ORG_B, () => getProviderWithFallbacks('anthropic', []))
    ).resolves.toMatchObject({ usedSlug: 'anthropic', breakerKey: `anthropic#org:${ORG_B}` });
  });

  it("does not let the shared credential's open breaker block an org with its own key", async () => {
    // Org A has its own key; everyone else is on the shared one ('').
    registerProviderCredentialResolver((_config, { orgId }) =>
      orgId === ORG_A
        ? { apiKey: 'key-for-a', identity: `org:${ORG_A}` }
        : { apiKey: 'shared-key', identity: '' }
    );
    const shared = getBreaker('anthropic');
    for (let i = 0; i < 10; i++) shared.recordFailure();

    await expect(
      runAsOrg(ORG_B, () => getProviderWithFallbacks('anthropic', []))
    ).rejects.toMatchObject({ code: 'all_providers_exhausted' });
    await expect(
      runAsOrg(ORG_A, () => getProviderWithFallbacks('anthropic', []))
    ).resolves.toMatchObject({ breakerKey: `anthropic#org:${ORG_A}` });
  });

  it('names the resolver, not the env var, when a registered resolver gives a row no key', async () => {
    registerProviderCredentialResolver(() => ({ apiKey: undefined, identity: 'org:none' }));

    await expect(runAsOrg(ORG_A, () => getProvider('anthropic'))).rejects.toMatchObject({
      code: 'missing_api_key',
      message: expect.stringContaining('credential resolver returned none'),
    });
  });

  it('shows an admin the worst breaker for the provider, and resets every credential', () => {
    const tripped = getBreaker(`anthropic#org:${ORG_A}`);
    for (let i = 0; i < 10; i++) tripped.recordFailure();
    getBreaker(`anthropic#org:${ORG_B}`);
    getBreaker('anthropic-other'); // another slug sharing a prefix

    expect(getCircuitBreakerStatusForProvider('anthropic')?.state).toBe('open');
    expect(getCircuitBreakerStatusForProvider('anthropic-other')?.state).toBe('closed');

    resetBreakersForProvider('anthropic');
    expect(tripped.canAttempt()).toBe(true);
  });

  it('counts calls in flight per credential', async () => {
    perOrgResolver();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = await runAsOrg(ORG_A, () => getProvider('anthropic'));
    clients[0].create.mockReturnValueOnce(
      gate.then(() => ({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'm',
        stop_reason: 'end_turn',
      }))
    );

    const pending = runAsOrg(ORG_A, () =>
      a.chat([{ role: 'user', content: 'hi' }], { model: 'm' })
    );
    await vi.waitFor(() =>
      expect(getInFlightCounts()).toEqual([{ provider: `anthropic#org:${ORG_A}`, inFlight: 1 }])
    );
    release();
    await pending;
    expect(getInFlightCounts()).toEqual([]);
  });

  it('makes the provider unavailable when the resolver throws, never using the env key', async () => {
    registerProviderCredentialResolver(() => {
      throw new Error('vault sealed');
    });

    await expect(runAsOrg(ORG_A, () => getProvider('anthropic'))).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    expect(clients).toHaveLength(0);
  });
});
