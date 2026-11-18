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

    expect(credential).toEqual({ apiKey: 'shared-install-key', identity: '' });
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
