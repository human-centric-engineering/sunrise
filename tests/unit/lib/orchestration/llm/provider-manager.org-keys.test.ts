/**
 * Organisations' own AI keys, through the provider manager (§137 t-1044).
 *
 * The load-bearing half of the feature: an org's saved key must reach the
 * client its calls go out on, and two orgs must never share a client, a
 * breaker or an in-flight count. So everything here goes through
 * `getProvider` at `multi` — the real credential seam, the real org-key
 * module, real sealing — with only the database, the switch and the
 * provider policy scripted.
 *
 * @see lib/orchestration/llm/org-provider-keys.ts
 * @see lib/orchestration/llm/provider-credentials.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envOverrides = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        typeof key === 'string' && key in envOverrides
          ? envOverrides[key]
          : (Reflect.get(target, key) as unknown),
    }),
  };
});

vi.mock('@/lib/db/client', async () => ({
  prisma: {
    aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() },
    aiOrgProviderKey: (await import('@/tests/helpers/org-provider-key-table')).orgKeyTable.delegate,
  },
}));

// The privacy stage and its resolver read nothing (see provider-manager.credentials.test.ts);
// the settings carry the switch.
vi.mock('@/lib/orchestration/privacy/scope-settings', async (importOriginal) =>
  (await import('@/tests/helpers/privacy-settings')).scopeSettingsReadingNothing(
    await importOriginal()
  )
);
const switchState = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/orchestration/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/settings')>()),
  getOrchestrationSettings: vi.fn(async () => ({
    ...(await import('@/tests/helpers/privacy-settings')).privacyOffSettings(),
    orgProviderKeysEnabled: switchState.on,
  })),
}));

// §120's policy, per org: which provider slugs each org is approved for. The
// call-time gate and the org-key lookup both read it.
const approvals = vi.hoisted(() => ({ byOrg: new Map<string, Set<string>>() }));
vi.mock('@/lib/orchestration/llm/org-provider-policy', async (importOriginal) => {
  const { getTenantContext } = await import('@/lib/tenancy/context');
  return {
    ...(await importOriginal<typeof import('@/lib/orchestration/llm/org-provider-policy')>()),
    applyOrgProviderPolicy: vi.fn(async (candidates: readonly string[]) => {
      const orgId = getTenantContext()?.orgId ?? null;
      const approved = orgId ? approvals.byOrg.get(orgId) : undefined;
      return candidates.filter((slug) => approved?.has(slug) === true);
    }),
  };
});

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** An Anthropic client the mock built: its key, and its two vendor calls. */
interface MockClient {
  apiKey: unknown;
  create: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}
/** Every Anthropic client constructed, with the key it was built with. */
const clients = vi.hoisted((): MockClient[] => []);
/** An error the next vendor call throws, once. */
const sdkFailure = vi.hoisted((): { next: Error | null } => ({ next: null }));
/** Keys the vendor refuses on every call, as a real one refuses a wrong key. */
const refusedKeys = vi.hoisted((): { keys: Set<unknown> } => ({
  keys: new Set(['sunrise-key-check-not-a-real-key']),
}));
/** Models the vendor will not serve on any key here, as a key restricted to some models. */
const refusedModels = vi.hoisted((): { models: Set<unknown> } => ({ models: new Set() }));
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages: { create: ReturnType<typeof vi.fn> };
    public models: { list: ReturnType<typeof vi.fn> };
    constructor(opts: { apiKey?: unknown }) {
      const refused = () =>
        Object.assign(new Error(`401 invalid x-api-key ${String(opts.apiKey)}`), { status: 401 });
      const create = vi.fn(async (args?: { model?: unknown }) => {
        if (refusedKeys.keys.has(opts.apiKey)) throw refused();
        if (refusedModels.models.has(args?.model)) {
          throw Object.assign(new Error(`403 model not allowed for ${String(opts.apiKey)}`), {
            status: 403,
          });
        }
        const failure = sdkFailure.next;
        sdkFailure.next = null;
        if (failure) throw failure;
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'm',
          stop_reason: 'end_turn',
        };
      });
      // The key test's call (t-1056): the model list, failing as `create` does.
      const list = vi.fn(async () => {
        if (refusedKeys.keys.has(opts.apiKey)) throw refused();
        const failure = sdkFailure.next;
        sdkFailure.next = null;
        if (failure) throw failure;
        return { data: [{ id: 'm' }] };
      });
      this.messages = { create };
      this.models = { list };
      clients.push({ apiKey: opts.apiKey, create, list });
    }
  }
  return { default: MockAnthropic };
});

import { prisma } from '@/lib/db/client';
import { getBreaker, resetAllBreakers } from '@/lib/orchestration/llm/circuit-breaker';
import {
  __resetInFlightCountersForTests,
  getInFlightCounts,
} from '@/lib/orchestration/llm/in-flight-counter';
import {
  forgetOrgProviderKey,
  removeOrgProviderKey,
  saveOrgProviderKey,
} from '@/lib/orchestration/llm/org-provider-keys';
import {
  registerProviderCredentialResolver,
  resetProviderCredentialResolver,
  resolveProviderCredential,
} from '@/lib/orchestration/llm/provider-credentials';
import { resetProviderEligibility } from '@/lib/orchestration/llm/provider-eligibility';
import {
  breakerKeyOf,
  clearCache,
  getProvider,
  getProviderWithFallbacks,
  testProviderKey,
  testProviderKeyOnModel,
} from '@/lib/orchestration/llm/provider-manager';
import { runAsOrg } from '@/lib/tenancy/context';
import { orgKeyTable } from '@/tests/helpers/org-provider-key-table';

const ORG_A = 'cmorg00000000000000000orga';
const ORG_B = 'cmorg00000000000000000orgb';
const ORG_C = 'cmorg00000000000000000orgc';
const KEY_A = 'sk-ant-org-a-0000000000000000000000000000wxyz';
const KEY_B = 'sk-ant-org-b-1111111111111111111111111111abcd';
const KEY_A2 = 'sk-ant-org-a-rotated-22222222222222222222efgh';

const ROW = {
  id: 'cmprov0000000000000000row1',
  slug: 'anthropic',
  name: 'Anthropic',
  providerType: 'anthropic',
  baseUrl: null,
  apiKeyEnvVar: 'ORG_KEYS_TEST_SHARED_KEY',
  isLocal: false,
  isActive: true,
  timeoutMs: null,
  maxRetries: null,
  metadata: null,
  createdAt: new Date(),
};

function save(orgId: string, apiKey: string) {
  return runAsOrg(orgId, () =>
    saveOrgProviderKey({ providerConfigId: ROW.id, apiKey, savedById: null })
  );
}

function chat(orgId: string) {
  return runAsOrg(orgId, async () => {
    const provider = await getProvider('anthropic');
    await provider.chat([{ role: 'user', content: 'hi' }], { model: 'm' });
    return provider;
  });
}

/** The keys each call went out on, in order. */
function callsByKey(): unknown[] {
  return clients.flatMap((c) => c.create.mock.calls.map(() => c.apiKey));
}

beforeEach(() => {
  vi.clearAllMocks();
  clients.length = 0;
  sdkFailure.next = null;
  refusedKeys.keys = new Set(['sunrise-key-check-not-a-real-key']);
  clearCache();
  resetAllBreakers();
  __resetInFlightCountersForTests();
  resetProviderCredentialResolver();
  resetProviderEligibility();
  orgKeyTable.clear();
  forgetOrgProviderKey();
  envOverrides.TENANCY_MODE = 'multi';
  envOverrides.SEALED_SECRET_KEYS = `one:${'m'.repeat(40)}`;
  envOverrides.SEALED_SECRET_ACTIVE_KEY = 'one';
  switchState.on = true;
  approvals.byOrg = new Map([
    [ORG_A, new Set(['anthropic'])],
    [ORG_B, new Set(['anthropic'])],
    [ORG_C, new Set(['anthropic'])],
  ]);
  vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(ROW as never);
  process.env.ORG_KEYS_TEST_SHARED_KEY = 'shared-install-key';
});

afterEach(() => {
  resetProviderCredentialResolver();
  delete process.env.ORG_KEYS_TEST_SHARED_KEY;
});

describe('two orgs with their own keys for one provider', () => {
  it('get two clients, and each call goes out on its own org’s key', async () => {
    await save(ORG_A, KEY_A);
    await save(ORG_B, KEY_B);

    const a = await chat(ORG_A);
    const b = await chat(ORG_B);

    expect(b).not.toBe(a);
    expect(clients.map((c) => c.apiKey).sort()).toEqual([KEY_A, KEY_B].sort());
    expect(callsByKey()).toEqual(expect.arrayContaining([KEY_A, KEY_B]));
    expect(callsByKey()).not.toContain('shared-install-key');
  });

  it('get two breakers: one org’s failures do not pause the other', async () => {
    const savedA = await save(ORG_A, KEY_A);
    const savedB = await save(ORG_B, KEY_B);
    const a = await runAsOrg(ORG_A, () => getProvider('anthropic'));
    const b = await runAsOrg(ORG_B, () => getProvider('anthropic'));

    expect(breakerKeyOf(a)).toBe(`anthropic#org-key:${ORG_A}:${savedA.id}:1`);
    expect(breakerKeyOf(b)).toBe(`anthropic#org-key:${ORG_B}:${savedB.id}:1`);

    const breakerA = getBreaker(breakerKeyOf(a)!);
    for (let i = 0; i < 10; i++) breakerA.recordFailure();

    await expect(
      runAsOrg(ORG_A, () => getProviderWithFallbacks('anthropic', []))
    ).rejects.toMatchObject({ code: 'all_providers_exhausted' });
    await expect(
      runAsOrg(ORG_B, () => getProviderWithFallbacks('anthropic', []))
    ).resolves.toMatchObject({ breakerKey: breakerKeyOf(b) });
  });

  it('get two in-flight counts', async () => {
    const savedA = await save(ORG_A, KEY_A);
    const savedB = await save(ORG_B, KEY_B);
    const a = await runAsOrg(ORG_A, () => getProvider('anthropic'));
    const b = await runAsOrg(ORG_B, () => getProvider('anthropic'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = () =>
      gate.then(() => ({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'm',
        stop_reason: 'end_turn',
      }));
    for (const client of clients) client.create.mockReturnValueOnce(held());

    const pending = [
      runAsOrg(ORG_A, () => a.chat([{ role: 'user', content: 'hi' }], { model: 'm' })),
      runAsOrg(ORG_B, () => b.chat([{ role: 'user', content: 'hi' }], { model: 'm' })),
    ];
    await vi.waitFor(() =>
      expect(getInFlightCounts().sort((x, y) => x.provider.localeCompare(y.provider))).toEqual([
        { provider: `anthropic#org-key:${ORG_A}:${savedA.id}:1`, inFlight: 1 },
        { provider: `anthropic#org-key:${ORG_B}:${savedB.id}:1`, inFlight: 1 },
      ])
    );
    release();
    await Promise.all(pending);
    expect(getInFlightCounts()).toEqual([]);
  });
});

describe("the install key's open breaker", () => {
  it('does not skip an org with its own key, and still skips an org without one', async () => {
    const savedA = await save(ORG_A, KEY_A);
    const shared = getBreaker('anthropic');
    for (let i = 0; i < 10; i++) shared.recordFailure();

    await expect(
      runAsOrg(ORG_A, () => getProviderWithFallbacks('anthropic', []))
    ).resolves.toMatchObject({ breakerKey: `anthropic#org-key:${ORG_A}:${savedA.id}:1` });
    await expect(
      runAsOrg(ORG_C, () => getProviderWithFallbacks('anthropic', []))
    ).rejects.toMatchObject({ code: 'all_providers_exhausted' });
  });
});

describe('an org without a key', () => {
  it('gets the install’s shared client, beside orgs with their own', async () => {
    await save(ORG_A, KEY_A);

    const c = await chat(ORG_C);

    expect(breakerKeyOf(c)).toBe('anthropic');
    expect(clients.map((cl) => cl.apiKey)).toEqual(['shared-install-key']);
  });

  it('gets the app resolver’s answer when one is registered, as before', async () => {
    registerProviderCredentialResolver((_config, { orgId }) => ({
      apiKey: `app-key-${orgId}`,
      identity: `app:${orgId}`,
    }));
    await save(ORG_A, KEY_A);

    const a = await chat(ORG_A);
    const c = await chat(ORG_C);

    // Org A's own key comes first; org C gets the app's answer.
    expect(breakerKeyOf(a)).toMatch(/^anthropic#org-key:/);
    expect(breakerKeyOf(c)).toBe(`anthropic#app:${ORG_C}`);
    expect(callsByKey().sort()).toEqual([KEY_A, `app-key-${ORG_C}`].sort());
  });
});

describe('the switch off with no keys saved', () => {
  it('resolves byte-for-byte as before: the env var, on the shared identity', async () => {
    switchState.on = false;

    const credential = await runAsOrg(ORG_A, () => resolveProviderCredential(ROW));
    const provider = await chat(ORG_A);

    expect(credential).toEqual({ apiKey: 'shared-install-key', identity: '', ownKey: false });
    expect(breakerKeyOf(provider)).toBe('anthropic');
  });
});

describe('a replaced or removed key, in the writing process', () => {
  it('is not used by the next fetch after it is replaced, inside the client cache’s 5 minutes', async () => {
    await save(ORG_A, KEY_A);
    await chat(ORG_A);

    await save(ORG_A, KEY_A2);
    await chat(ORG_A);

    expect(callsByKey()).toEqual([KEY_A, KEY_A2]);
  });

  it('is not used by the next fetch after it is removed: the org is back on the shared key', async () => {
    await save(ORG_A, KEY_A);
    await chat(ORG_A);

    await runAsOrg(ORG_A, () => removeOrgProviderKey(ROW.id));
    const after = await chat(ORG_A);

    expect(callsByKey()).toEqual([KEY_A, 'shared-install-key']);
    expect(breakerKeyOf(after)).toBe('anthropic');
  });
});

describe('a key that cannot be used is refused, never swapped for the shared key', () => {
  async function expectRefusedThroughGetProvider() {
    await expect(runAsOrg(ORG_A, () => getProvider('anthropic'))).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    expect(clients).toHaveLength(0);
  }

  it('while the switch is off', async () => {
    await save(ORG_A, KEY_A);
    switchState.on = false;
    await expectRefusedThroughGetProvider();
  });

  it('for a provider the org is not approved for', async () => {
    await save(ORG_A, KEY_A);
    approvals.byOrg.set(ORG_A, new Set());
    await expectRefusedThroughGetProvider();
  });

  it('when it will not open', async () => {
    await save(ORG_A, KEY_A);
    envOverrides.SEALED_SECRET_KEYS = `two:${'n'.repeat(40)}`;
    envOverrides.SEALED_SECRET_ACTIVE_KEY = 'two';
    await expectRefusedThroughGetProvider();
  });

  it('and not handed to the app’s resolver either', async () => {
    const resolver = vi.fn(() => ({ apiKey: 'app-key', identity: 'app' }));
    registerProviderCredentialResolver(resolver);
    await save(ORG_A, KEY_A);
    switchState.on = false;

    await expectRefusedThroughGetProvider();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('while other orgs keep working', async () => {
    await save(ORG_A, KEY_A);
    switchState.on = false;

    await expect(runAsOrg(ORG_A, () => getProvider('anthropic'))).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    await chat(ORG_C);
    expect(callsByKey()).toEqual(['shared-install-key']);
  });
});

describe('at single', () => {
  it('reads no org key at all', async () => {
    envOverrides.TENANCY_MODE = 'single';

    await chat(ORG_A);

    expect(orgKeyTable.delegate.findUnique).not.toHaveBeenCalled();
    expect(callsByKey()).toEqual(['shared-install-key']);
  });
});

describe('testing a key before it is saved (t-1045)', () => {
  it('asks the vendor on the submitted key, on clients the manager never caches', async () => {
    const result = await testProviderKey(ROW as never, KEY_B);

    expect(result.ok).toBe(true);
    // The row's client, then the test's two: the key, and a known-wrong one.
    expect(clients.map((c) => c.apiKey)).toEqual([
      KEY_B,
      KEY_B,
      'sunrise-key-check-not-a-real-key',
    ]);
    // The key test (t-1056): Anthropic's model list, which it authenticates,
    // and no message: nothing billed, no fixed model the key must reach.
    expect(clients[1].list).toHaveBeenCalledTimes(1);
    expect(clients.every((c) => c.create.mock.calls.length === 0)).toBe(true);

    // The org's next call is built afresh on its own key, never on the tested one.
    const built = clients.length;
    await save(ORG_A, KEY_A);
    await chat(ORG_A);
    expect(clients.slice(built).map((c) => c.apiKey)).toEqual([KEY_A]);
    expect(clients[built].create).toHaveBeenCalledTimes(1);
  });

  it('answers a refused key as a failed test, with the vendor’s message for the caller to scrub', async () => {
    vi.mocked(prisma.aiProviderConfig.findFirst).mockClear();
    refusedKeys.keys.add(KEY_B);

    const result = await testProviderKey(ROW as never, KEY_B);

    expect(result).toEqual({ ok: false, models: [], error: `401 invalid x-api-key ${KEY_B}` });
    // Built from the row it was handed: no read of the provider table.
    expect(prisma.aiProviderConfig.findFirst).not.toHaveBeenCalled();
  });
});

describe('testing an org’s key against one model, before the model move (§136 t-1066)', () => {
  afterEach(() => {
    refusedModels.models.clear();
    refusedKeys.keys.delete(KEY_B);
  });

  it('passes a key the vendor accepts and a short message to the model succeeds on', async () => {
    const result = await testProviderKeyOnModel(ROW as never, KEY_B, 'claude-new', { chat: true });

    expect(result).toEqual({ ok: true });
    // The key test's clients (the key and a known-wrong one), then the message
    // on the key's own client, to the model named.
    const mine = clients.filter((c) => c.apiKey === KEY_B);
    const sent = mine.flatMap((c) => c.create.mock.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({
      model: 'claude-new',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('fails at the model when the key passes but may not use it', async () => {
    refusedModels.models.add('claude-new');

    const result = await testProviderKeyOnModel(ROW as never, KEY_B, 'claude-new', { chat: true });

    expect(result).toEqual({
      ok: false,
      failedAt: 'model',
      error: expect.stringContaining('403 model not allowed'),
    });
  });

  it('fails at the key, sending the model nothing, when the vendor refuses the key', async () => {
    refusedKeys.keys.add(KEY_B);

    const result = await testProviderKeyOnModel(ROW as never, KEY_B, 'claude-new', { chat: true });

    expect(result).toMatchObject({ ok: false, failedAt: 'key' });
    // The key test may send its own one-token message where the model list
    // proves nothing; none goes to the model under test.
    const toModel = clients.flatMap((c) =>
      c.create.mock.calls.filter((call) => (call[0] as { model?: unknown }).model === 'claude-new')
    );
    expect(toModel).toEqual([]);
  });

  it('tests the key alone for a model that is not a chat model', async () => {
    refusedModels.models.add('voyage-x');

    const result = await testProviderKeyOnModel(ROW as never, KEY_B, 'voyage-x', { chat: false });

    expect(result).toEqual({ ok: true });
    expect(clients.every((c) => c.create.mock.calls.length === 0)).toBe(true);
  });
});
