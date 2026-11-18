/**
 * Organisations' own AI keys: the store, the lookup and its refusals (§137 t-1044).
 *
 * The sealing is real (a keyring set through the mocked env), so "will not
 * open" is a real AES-GCM failure and "the key is never logged" is checked
 * against what was actually sealed. The table is an in-memory stand-in with
 * the unique key, version increment and compare-and-swap of the real one.
 * The switch and the provider policy are scripted per test.
 *
 * What goes through the provider manager — separate clients, breakers and
 * in-flight counts per org — is `provider-manager.org-keys.test.ts`.
 *
 * @see lib/orchestration/llm/org-provider-keys.ts
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
    aiOrgProviderKey: (await import('@/tests/helpers/org-provider-key-table')).orgKeyTable.delegate,
  },
}));

const switchState = vi.hoisted(() => ({ on: true, throws: false }));
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn(async () => {
    if (switchState.throws) throw new Error('settings unreadable');
    return { orgProviderKeysEnabled: switchState.on };
  }),
}));

const approvals = vi.hoisted(() => ({ slugs: new Set<string>(['anthropic']) }));
vi.mock('@/lib/orchestration/llm/org-provider-policy', () => ({
  applyOrgProviderPolicy: vi.fn(async (candidates: readonly string[]) =>
    candidates.filter((slug) => approvals.slugs.has(slug))
  ),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  countOrgsWithProviderKeys,
  forgetOrgProviderKey,
  ORG_PROVIDER_KEY_TTL_MS,
  orgProviderKeyPurpose,
  orgProviderKeySealedStore,
  removeOrgProviderKey,
  resolveOrgProviderKey,
  saveOrgProviderKey,
} from '@/lib/orchestration/llm/org-provider-keys';
import { SealedSecretKeyMissingError, openSecret } from '@/lib/security/sealed-secrets';
import { __resetSealedStoresForTests, resealSealedStores } from '@/lib/security/sealed-stores';
import { runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { orgKeyTable } from '@/tests/helpers/org-provider-key-table';

const ORG_A = 'cmorg00000000000000000orga';
const ORG_B = 'cmorg00000000000000000orgb';
const ROW = { id: 'cmprov0000000000000000row1', slug: 'anthropic' };
const KEY_A = 'sk-ant-org-a-0000000000000000000000000000wxyz';
const KEY_B = 'sk-ant-org-b-1111111111111111111111111111abcd';
const MASTER_1 = 'master-key-one-0123456789abcdefghijklmnop';
const MASTER_2 = 'master-key-two-ZYXWVUTSRQPONMLKJIHGFEDCBA';

function keyring(...ids: Array<'one' | 'two'>): void {
  const secrets = { one: MASTER_1, two: MASTER_2 };
  envOverrides.SEALED_SECRET_KEYS = ids.map((id) => `${id}:${secrets[id]}`).join(',');
  envOverrides.SEALED_SECRET_ACTIVE_KEY = ids[0];
}

function noKeyring(): void {
  delete envOverrides.SEALED_SECRET_KEYS;
  delete envOverrides.SEALED_SECRET_ACTIVE_KEY;
}

/** Save a key as `orgId` would, through the module. */
function save(orgId: string, apiKey: string, savedById: string | null = 'user-1') {
  return runAsOrg(orgId, () => saveOrgProviderKey({ providerConfigId: ROW.id, apiKey, savedById }));
}

function resolve(orgId: string) {
  return runAsOrg(orgId, () => resolveOrgProviderKey(ROW, orgId));
}

/** Everything the module logged, as one string. */
function logged(): string {
  return JSON.stringify([
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
    vi.mocked(logger.info).mock.calls,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  orgKeyTable.clear();
  forgetOrgProviderKey();
  envOverrides.TENANCY_MODE = 'multi';
  keyring('one');
  switchState.on = true;
  switchState.throws = false;
  approvals.slugs = new Set(['anthropic']);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveOrgProviderKey', () => {
  it('answers null for an org with no key, so it resolves as before', async () => {
    await expect(resolve(ORG_A)).resolves.toBeNull();
  });

  it("answers the org's own key, under an identity naming the org, the row and the version", async () => {
    const saved = await save(ORG_A, KEY_A);

    await expect(resolve(ORG_A)).resolves.toEqual({
      apiKey: KEY_A,
      identity: `org-key:${ORG_A}:${saved.id}:1`,
    });
  });

  it('gives each org its own key and never the other', async () => {
    await save(ORG_A, KEY_A);
    await save(ORG_B, KEY_B);

    expect((await resolve(ORG_A))?.apiKey).toBe(KEY_A);
    expect((await resolve(ORG_B))?.apiKey).toBe(KEY_B);
  });

  it('reads the table once per org and row within the TTL', async () => {
    await save(ORG_A, KEY_A);
    orgKeyTable.delegate.findUnique.mockClear();

    await resolve(ORG_A);
    await resolve(ORG_A);
    await Promise.all([resolve(ORG_A), resolve(ORG_A)]);

    expect(orgKeyTable.delegate.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('a key replaced or removed in this process', () => {
  it('is used, under a new identity, by the next lookup after a save over it', async () => {
    const first = await save(ORG_A, KEY_A);
    const before = await resolve(ORG_A);

    const second = await save(ORG_A, KEY_B, 'user-2');
    const after = await resolve(ORG_A);

    expect(second).toMatchObject({ id: first.id, version: 2, hint: 'abcd', savedById: 'user-2' });
    expect(after).toEqual({ apiKey: KEY_B, identity: `org-key:${ORG_A}:${first.id}:2` });
    expect(after?.identity).not.toBe(before?.identity);
  });

  it('is gone from the next lookup once removed', async () => {
    await save(ORG_A, KEY_A);
    await resolve(ORG_A);

    await expect(runAsOrg(ORG_A, () => removeOrgProviderKey(ROW.id))).resolves.toBe(true);

    await expect(resolve(ORG_A)).resolves.toBeNull();
  });

  it('gets a new identity when removed and saved again, though its version starts at 1 again', async () => {
    const first = await save(ORG_A, KEY_A);
    const before = await resolve(ORG_A);
    await runAsOrg(ORG_A, () => removeOrgProviderKey(ROW.id));
    const again = await save(ORG_A, KEY_B);
    const after = await resolve(ORG_A);

    expect(again.version).toBe(1);
    expect(again.id).not.toBe(first.id);
    // A client built with the removed key, still cached under its identity,
    // can never answer for the new one.
    expect(after?.identity).not.toBe(before?.identity);
  });

  it('answers whether there was a key to remove', async () => {
    await expect(runAsOrg(ORG_A, () => removeOrgProviderKey(ROW.id))).resolves.toBe(false);
  });
});

describe('a key changed by another process', () => {
  // Another process's write reaches this table but not this process's cache.
  let now: number;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  it(`is still answered here for up to ${ORG_PROVIDER_KEY_TTL_MS / 1000} seconds, then not`, async () => {
    await save(ORG_A, KEY_A);
    const before = await resolve(ORG_A);

    // Removed elsewhere.
    orgKeyTable.rows.clear();

    now += ORG_PROVIDER_KEY_TTL_MS - 1;
    await expect(resolve(ORG_A)).resolves.toEqual(before);

    now += 1;
    await expect(resolve(ORG_A)).resolves.toBeNull();
  });

  it('is not used here until the TTL runs out when newly saved elsewhere', async () => {
    await expect(resolve(ORG_A)).resolves.toBeNull();

    // Saved elsewhere: write the row without going through this process's module.
    const sealed = await runAsSystem('test', async () => {
      const { sealSecret } = await import('@/lib/security/sealed-secrets');
      return sealSecret(KEY_A, orgProviderKeyPurpose(ORG_A, ROW.id));
    });
    orgKeyTable.rows.set('elsewhere', {
      id: 'elsewhere',
      orgId: ORG_A,
      providerConfigId: ROW.id,
      sealedKey: sealed,
      version: 1,
      hint: 'wxyz',
      savedById: null,
      savedAt: new Date(),
      createdAt: new Date(),
    });

    await expect(resolve(ORG_A)).resolves.toBeNull();
    now += ORG_PROVIDER_KEY_TTL_MS;
    await expect(resolve(ORG_A)).resolves.toMatchObject({ apiKey: KEY_A });
  });
});

describe('refusals: an org with a key is never moved to another key', () => {
  async function expectRefused(reason: string) {
    await expect(resolve(ORG_A)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'credential_unavailable',
      retriable: false,
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('own key'),
      expect.objectContaining({ orgId: ORG_A, provider: 'anthropic', reason })
    );
  }

  it('refuses while the switch is off', async () => {
    await save(ORG_A, KEY_A);
    switchState.on = false;
    await expectRefused('switched_off');
  });

  it('refuses a key for a provider the org is not approved for', async () => {
    await save(ORG_A, KEY_A);
    approvals.slugs = new Set();
    await expectRefused('not_approved');
  });

  it('refuses a key that will not open because its master key is gone', async () => {
    await save(ORG_A, KEY_A);
    keyring('two');
    await expectRefused('will_not_open');
  });

  it('refuses a key when no master key is configured at all', async () => {
    await save(ORG_A, KEY_A);
    noKeyring();
    await expectRefused('will_not_open');
  });

  it("refuses another org's envelope copied onto this org's row", async () => {
    await save(ORG_A, KEY_A);
    await save(ORG_B, KEY_B);
    orgKeyTable.get(ORG_A, ROW.id)!.sealedKey = orgKeyTable.get(ORG_B, ROW.id)!.sealedKey;
    await expectRefused('will_not_open');
  });

  it('refuses when whether the org has a key cannot be read, and asks again next time', async () => {
    orgKeyTable.delegate.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    await expectRefused('lookup_failed');

    // The failed read was not cached as an answer.
    await expect(resolve(ORG_A)).resolves.toBeNull();
  });

  it('refuses when the switch cannot be read', async () => {
    await save(ORG_A, KEY_A);
    switchState.throws = true;
    await expectRefused('lookup_failed');
  });

  it('logs a refusal once a minute per org, row and reason, not on every check', async () => {
    const now = vi.spyOn(Date, 'now');
    let t = 5_000_000;
    now.mockImplementation(() => t);
    await save(ORG_A, KEY_A);
    switchState.on = false;
    vi.mocked(logger.warn).mockClear();

    for (let i = 0; i < 3; i += 1) await resolve(ORG_A).catch(() => undefined);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);

    // Still refused every time; only the log is spaced out.
    await expect(resolve(ORG_A)).rejects.toMatchObject({ code: 'credential_unavailable' });
    t += ORG_PROVIDER_KEY_TTL_MS;
    await resolve(ORG_A).catch(() => undefined);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
  });

  it('logs neither the key nor its envelope on any refusal', async () => {
    await save(ORG_A, KEY_A);
    const envelope = orgKeyTable.get(ORG_A, ROW.id)!.sealedKey;
    keyring('two');
    await resolve(ORG_A).catch(() => undefined);
    switchState.on = false;
    await resolve(ORG_A).catch(() => undefined);

    expect(logged()).not.toContain(KEY_A);
    expect(logged()).not.toContain(envelope);
  });
});

describe('saveOrgProviderKey', () => {
  it('stores the key sealed for this org and row, and its last four characters', async () => {
    const saved = await save(ORG_A, KEY_A);
    const row = orgKeyTable.get(ORG_A, ROW.id)!;

    expect(row.sealedKey).not.toContain(KEY_A);
    expect(row.sealedKey.startsWith('v2.one.')).toBe(true);
    await expect(openSecret(row.sealedKey, orgProviderKeyPurpose(ORG_A, ROW.id))).resolves.toBe(
      KEY_A
    );
    expect(saved).toEqual({
      id: row.id,
      orgId: ORG_A,
      providerConfigId: ROW.id,
      version: 1,
      hint: 'wxyz',
      savedById: 'user-1',
      savedAt: expect.any(Date),
      createdAt: expect.any(Date),
    });
    // What it answers carries no part of the key but the hint.
    expect(JSON.stringify(saved)).not.toContain(KEY_A.slice(0, 20));
  });

  it('stores no hint for a key so short that four characters would be much of it', async () => {
    const saved = await save(ORG_A, 'short-key-15chr');
    expect(saved.hint).toBe('');
    expect(orgKeyTable.get(ORG_A, ROW.id)!.hint).toBe('');
  });

  it.each([
    ['an empty key', ''],
    ['a key with surrounding spaces', ` ${KEY_A}`],
    ['a key longer than any vendor issues', 'k'.repeat(1025)],
  ])('refuses %s, writing nothing', async (_label, apiKey) => {
    await expect(save(ORG_A, apiKey)).rejects.toThrow(/1–1024 characters/);
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('refuses with no master key configured, writing nothing', async () => {
    noKeyring();
    await expect(save(ORG_A, KEY_A)).rejects.toBeInstanceOf(SealedSecretKeyMissingError);
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('refuses outside an org scope at multi', async () => {
    await expect(
      runAsSystem('test', () =>
        saveOrgProviderKey({ providerConfigId: ROW.id, apiKey: KEY_A, savedById: null })
      )
    ).rejects.toThrow(/inside that org’s scope/);
  });
});

describe('countOrgsWithProviderKeys', () => {
  it('counts orgs, not keys', async () => {
    await save(ORG_A, KEY_A);
    await runAsOrg(ORG_A, () =>
      saveOrgProviderKey({
        providerConfigId: 'cmprov0000000000000000row2',
        apiKey: KEY_B,
        savedById: null,
      })
    );
    await save(ORG_B, KEY_B);

    await expect(countOrgsWithProviderKeys()).resolves.toBe(2);
  });
});

describe('the reseal walk over orgs’ keys', () => {
  beforeEach(() => {
    __resetSealedStoresForTests();
  });

  it('moves every key onto the new master key; each still answers, under the same identity', async () => {
    await save(ORG_A, KEY_A);
    await save(ORG_B, KEY_B);
    const before = [await resolve(ORG_A), await resolve(ORG_B)];

    keyring('two', 'one');
    const report = await resealSealedStores();
    keyring('two');

    expect(report.ok).toBe(true);
    expect(report.stores).toEqual([
      expect.objectContaining({ store: 'org-provider-keys', scanned: 2, resealed: 2 }),
    ]);
    expect(orgKeyTable.get(ORG_A, ROW.id)!.sealedKey.startsWith('v2.two.')).toBe(true);
    // Only the envelope moved: the same key, the same version, so the same client.
    expect([await resolve(ORG_A), await resolve(ORG_B)]).toEqual(before);
  });

  it('never overwrites a key saved between its read and its write', async () => {
    await save(ORG_A, KEY_A);
    const previous = orgKeyTable.get(ORG_A, ROW.id)!.sealedKey;
    await save(ORG_A, KEY_B);

    await expect(
      orgProviderKeySealedStore.replace(orgKeyTable.get(ORG_A, ROW.id)!.id, previous, 'v2.x.y.z.w')
    ).resolves.toBe(false);
    expect((await resolve(ORG_A))?.apiKey).toBe(KEY_B);
  });

  it('lists every key across pages, each with the purpose it was sealed for', async () => {
    for (let i = 0; i < 205; i += 1) {
      orgKeyTable.rows.set(`k${String(i).padStart(4, '0')}`, {
        id: `k${String(i).padStart(4, '0')}`,
        orgId: `org${i}`,
        providerConfigId: ROW.id,
        sealedKey: 'v2.one.a.b.c',
        version: 1,
        hint: 'abcd',
        savedById: null,
        savedAt: new Date(),
        createdAt: new Date(),
      });
    }

    const listed = [];
    for await (const value of orgProviderKeySealedStore.list()) listed.push(value);

    expect(listed).toHaveLength(205);
    expect(new Set(listed.map((v) => v.id)).size).toBe(205);
    expect(listed[204]).toEqual({
      id: 'k0204',
      sealed: 'v2.one.a.b.c',
      purpose: orgProviderKeyPurpose('org204', ROW.id),
    });
  });
});
