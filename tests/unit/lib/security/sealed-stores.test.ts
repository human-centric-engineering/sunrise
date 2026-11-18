/**
 * Tests: the sealed-store registry and the reseal walk (§137 t-1043).
 *
 * The stores are in-memory, but the sealing is real: a value is resealed only
 * if it really opens, and "on the active key" is read back from the stored
 * envelope, not from a counter. What is mocked is the fork's init (so a
 * registration and a throwing one can both be exercised), the tenancy scope
 * (recorded, so the walk is shown to run as the platform) and the logger.
 *
 * @see lib/security/sealed-stores.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface KeyringEnv {
  SEALED_SECRET_KEYS?: string;
  SEALED_SECRET_ACTIVE_KEY?: string;
  SEALED_SECRET_LEGACY_KEY?: string;
}
const mockEnv = vi.hoisted((): KeyringEnv => ({}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const appInit = vi.hoisted(() => ({ impl: (): void => {} }));
vi.mock('@/lib/app/sealed-stores', () => ({
  initAppSealedStores: () => appInit.impl(),
}));

const scopes = vi.hoisted(() => ({ reasons: [] as string[], depth: 0, maxDepthSeen: 0 }));
vi.mock('@/lib/tenancy/context', () => ({
  runAsSystem: async <T>(reason: string, fn: () => Promise<T>): Promise<T> => {
    scopes.reasons.push(reason);
    scopes.depth += 1;
    try {
      return await fn();
    } finally {
      scopes.depth -= 1;
    }
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { needsReseal, openSecret, sealSecret } from '@/lib/security/sealed-secrets';
import {
  __resetSealedStoresForTests,
  getSealedStoreNames,
  registerSealedStore,
  resealSealedStores,
  SealedStoreRegistrationError,
  type SealedStore,
  type SealedValue,
} from '@/lib/security/sealed-stores';
import { SealedSecretKeyMissingError } from '@/lib/security/sealed-secrets';

const KEY_OLD = 'older-master-key-0123456789abcdefghijklmn';
const KEY_NEW = 'newer-master-key-ZYXWVUTSRQPONMLKJIHGFEDC';
const CONQUEST_KEY = 'conquest-fixture-key-0123456789abcdefghij';
const CONQUEST_V1 = 'v1.RUPx0zJaLwAvvy-M.MAz8vErQe-Ng9Xgb3s97IQ.V30IQu61xOvAo3_1sfn6KQ7XzgE';

function configureOldKeyOnly(): void {
  mockEnv.SEALED_SECRET_KEYS = `old:${KEY_OLD},conquest:${CONQUEST_KEY}`;
  mockEnv.SEALED_SECRET_ACTIVE_KEY = 'old';
  mockEnv.SEALED_SECRET_LEGACY_KEY = 'conquest';
}

function rotateToNewKey(): void {
  mockEnv.SEALED_SECRET_KEYS = `new:${KEY_NEW},old:${KEY_OLD},conquest:${CONQUEST_KEY}`;
  mockEnv.SEALED_SECRET_ACTIVE_KEY = 'new';
  mockEnv.SEALED_SECRET_LEGACY_KEY = 'conquest';
}

/** An in-memory store whose `replace` is a real compare-and-swap. */
class MemoryStore implements SealedStore {
  readonly rows = new Map<string, { sealed: string; purpose: string }>();
  writes = 0;
  /** Runs between the walk reading a row and writing it, to simulate a concurrent save. */
  beforeReplace: ((id: string) => Promise<void>) | null = null;
  listThrowsAfter: number | null = null;
  replaceThrowsFor: string | null = null;

  constructor(readonly name: string) {}

  async *list(): AsyncIterable<SealedValue> {
    let yielded = 0;
    for (const [id, row] of [...this.rows.entries()]) {
      if (this.listThrowsAfter !== null && yielded >= this.listThrowsAfter) {
        throw new Error(`listing ${this.name} broke`);
      }
      yielded += 1;
      yield { id, sealed: row.sealed, purpose: row.purpose };
    }
  }

  async replace(id: string, previous: string, next: string): Promise<boolean> {
    if (this.beforeReplace) await this.beforeReplace(id);
    if (this.replaceThrowsFor === id) throw new Error('database unavailable');
    const row = this.rows.get(id);
    if (!row || row.sealed !== previous) return false;
    row.sealed = next;
    this.writes += 1;
    return true;
  }

  async put(id: string, plaintext: string, purpose = `test:${id}`): Promise<void> {
    this.rows.set(id, { sealed: await sealSecret(plaintext, purpose), purpose });
  }
}

beforeEach(() => {
  __resetSealedStoresForTests();
  appInit.impl = () => {};
  scopes.reasons = [];
  configureOldKeyOnly();
});

describe('resealSealedStores', () => {
  it('moves every value onto the active key, and each still opens to what it was', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    await crm.put('b', 'token-b');
    crm.rows.set('legacy', { sealed: CONQUEST_V1, purpose: 'crm:hubspot:access' });
    registerSealedStore(crm);
    rotateToNewKey();

    const report = await resealSealedStores();

    expect(report).toMatchObject({ ok: true, dryRun: false, activeKeyId: 'new' });
    expect(report.stores).toEqual([
      {
        store: 'crm',
        scanned: 3,
        alreadyCurrent: 0,
        resealed: 3,
        changedMeanwhile: 0,
        failed: [],
      },
    ]);
    for (const [id, row] of crm.rows) {
      expect(needsReseal(row.sealed), id).toBe(false);
      expect(row.sealed.startsWith('v2.new.')).toBe(true);
    }
    await expect(openSecret(crm.rows.get('a')!.sealed, 'test:a')).resolves.toBe('token-a');
    await expect(openSecret(crm.rows.get('legacy')!.sealed, 'crm:hubspot:access')).resolves.toBe(
      'sk-ant-fixture-token'
    );
  });

  it('then lets the old keys be removed without losing a value', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    registerSealedStore(crm);
    rotateToNewKey();
    await resealSealedStores();

    mockEnv.SEALED_SECRET_KEYS = `new:${KEY_NEW}`;
    delete mockEnv.SEALED_SECRET_LEGACY_KEY;
    await expect(openSecret(crm.rows.get('a')!.sealed, 'test:a')).resolves.toBe('token-a');
  });

  it('writes nothing on a second run', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    registerSealedStore(crm);
    rotateToNewKey();
    await resealSealedStores();
    const writesAfterFirst = crm.writes;
    const before = crm.rows.get('a')!.sealed;

    const second = await resealSealedStores();

    expect(crm.writes).toBe(writesAfterFirst);
    expect(crm.rows.get('a')!.sealed).toBe(before);
    expect(second.stores[0]).toMatchObject({ scanned: 1, alreadyCurrent: 1, resealed: 0 });
  });

  it('runs clean with no stores registered', async () => {
    await expect(resealSealedStores()).resolves.toEqual({
      dryRun: false,
      activeKeyId: 'old',
      stores: [],
      ok: true,
    });
  });

  it('runs clean on a store with no values', async () => {
    registerSealedStore(new MemoryStore('empty'));
    const report = await resealSealedStores();
    expect(report.ok).toBe(true);
    expect(report.stores[0]).toMatchObject({ scanned: 0, resealed: 0 });
  });

  it('counts but writes nothing on a dry run', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    const before = crm.rows.get('a')!.sealed;
    registerSealedStore(crm);
    rotateToNewKey();

    const report = await resealSealedStores({ dryRun: true });

    expect(report).toMatchObject({ ok: true, dryRun: true });
    expect(report.stores[0]).toMatchObject({ scanned: 1, resealed: 1 });
    expect(crm.writes).toBe(0);
    expect(crm.rows.get('a')!.sealed).toBe(before);
  });

  it('never overwrites a value saved between its read and its write', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    registerSealedStore(crm);
    rotateToNewKey();
    crm.beforeReplace = async (id) => {
      // Someone saves a new token for this row while the walk is mid-way.
      await crm.put(id, 'token-a-newer');
      crm.beforeReplace = null;
    };

    const report = await resealSealedStores();

    expect(report.stores[0]).toMatchObject({ resealed: 0, changedMeanwhile: 1 });
    await expect(openSecret(crm.rows.get('a')!.sealed, 'test:a')).resolves.toBe('token-a-newer');
  });

  it('is not ok when a value changed under it, because the writer may be on the old key', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    registerSealedStore(crm);
    rotateToNewKey();
    crm.beforeReplace = async (id) => {
      // A process not yet restarted onto the new key saves this row mid-walk.
      configureOldKeyOnly();
      await crm.put(id, 'token-a-from-old-process');
      rotateToNewKey();
      crm.beforeReplace = null;
    };

    const first = await resealSealedStores();

    expect(first.ok).toBe(false);
    expect(first.stores[0]).toMatchObject({ changedMeanwhile: 1, failed: [] });
    expect(needsReseal(crm.rows.get('a')!.sealed)).toBe(true);

    // Running it again, as the report says, moves it.
    const second = await resealSealedStores();
    expect(second.ok).toBe(true);
    expect(needsReseal(crm.rows.get('a')!.sealed)).toBe(false);
  });

  it('reports a value that will not open by id and reason, leaves it, and is not ok', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('good', 'token-good');
    crm.rows.set('wrong-purpose', {
      sealed: await sealSecret('token-x', 'test:other'),
      purpose: 'test:wrong-purpose',
    });
    crm.rows.set('garbage', { sealed: 'not-sealed', purpose: 'test:garbage' });
    const unopenable = crm.rows.get('wrong-purpose')!.sealed;
    registerSealedStore(crm);
    rotateToNewKey();

    const report = await resealSealedStores();

    expect(report.ok).toBe(false);
    expect(report.stores[0].failed).toEqual([
      { id: 'wrong-purpose', reason: 'mismatch' },
      { id: 'garbage', reason: 'format' },
    ]);
    expect(report.stores[0].resealed).toBe(1);
    expect(crm.rows.get('wrong-purpose')!.sealed).toBe(unopenable);
  });

  it('reports a value under a key already removed as unknown_key', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    registerSealedStore(crm);
    mockEnv.SEALED_SECRET_KEYS = `new:${KEY_NEW}`;
    mockEnv.SEALED_SECRET_ACTIVE_KEY = 'new';
    delete mockEnv.SEALED_SECRET_LEGACY_KEY;

    const report = await resealSealedStores();

    expect(report.ok).toBe(false);
    expect(report.stores[0].failed).toEqual([{ id: 'a', reason: 'unknown_key' }]);
  });

  it('reports a failed write as write_failed and carries on', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    await crm.put('b', 'token-b');
    crm.replaceThrowsFor = 'a';
    registerSealedStore(crm);
    rotateToNewKey();

    const report = await resealSealedStores();

    expect(report.ok).toBe(false);
    expect(report.stores[0]).toMatchObject({
      resealed: 1,
      failed: [{ id: 'a', reason: 'write_failed', detail: 'Error' }],
    });
  });

  it('names a failed write by its error name and code, never its message', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-a');
    crm.replace = async (_id, _previous, next) => {
      const err = new Error(`Invalid update: data { sealedToken: "${next}" }`);
      err.name = 'PrismaClientKnownRequestError';
      Object.assign(err, { code: 'P2025' });
      throw err;
    };
    registerSealedStore(crm);
    rotateToNewKey();

    const report = await resealSealedStores();

    expect(report.stores[0].failed).toEqual([
      { id: 'a', reason: 'write_failed', detail: 'PrismaClientKnownRequestError P2025' },
    ]);
    expect(JSON.stringify(report)).not.toContain('sealedToken');
  });

  it('fails a row listed with no purpose, and walks on to the next', async () => {
    const crm = new MemoryStore('crm');
    crm.rows.set('no-purpose', { sealed: await sealSecret('token-x', 'test:x'), purpose: '' });
    await crm.put('b', 'token-b');
    registerSealedStore(crm);
    rotateToNewKey();

    const report = await resealSealedStores();

    expect(report.ok).toBe(false);
    expect(report.stores[0]).toMatchObject({
      scanned: 2,
      resealed: 1,
      failed: [{ id: 'no-purpose', reason: 'invalid_purpose' }],
    });
    expect(report.stores[0].error).toBeUndefined();
  });

  it('reports a store whose listing breaks, and still walks the next store', async () => {
    const broken = new MemoryStore('broken');
    await broken.put('a', 'token-a');
    await broken.put('b', 'token-b');
    broken.listThrowsAfter = 1;
    const fine = new MemoryStore('fine');
    await fine.put('c', 'token-c');
    registerSealedStore(broken);
    registerSealedStore(fine);
    rotateToNewKey();

    const report = await resealSealedStores();

    expect(report.ok).toBe(false);
    expect(report.stores[0]).toMatchObject({
      store: 'broken',
      scanned: 1,
      resealed: 1,
      error: 'listing broken broke',
    });
    expect(report.stores[1]).toMatchObject({ store: 'fine', resealed: 1 });
    expect(report.stores[1].error).toBeUndefined();
  });

  it('walks each store as the platform, one scope per store', async () => {
    registerSealedStore(new MemoryStore('crm'));
    registerSealedStore(new MemoryStore('ads'));
    const seenInside: number[] = [];
    const probe = new MemoryStore('probe');
    probe.list = async function* () {
      seenInside.push(scopes.depth);
      yield* [];
    };
    registerSealedStore(probe);

    await resealSealedStores();

    expect(scopes.reasons).toEqual([
      'reseal sealed secrets: crm',
      'reseal sealed secrets: ads',
      'reseal sealed secrets: probe',
    ]);
    expect(seenInside).toEqual([1]);
  });

  it('puts no plaintext or envelope in its report', async () => {
    const crm = new MemoryStore('crm');
    await crm.put('a', 'token-PLAINTEXT-a');
    crm.rows.set('bad', { sealed: CONQUEST_V1, purpose: 'wrong' });
    const envelopes = [...crm.rows.values()].map((r) => r.sealed);
    registerSealedStore(crm);
    rotateToNewKey();

    const text = JSON.stringify(await resealSealedStores());

    expect(text).not.toContain('token-PLAINTEXT-a');
    for (const envelope of envelopes) expect(text).not.toContain(envelope);
    for (const row of crm.rows.values()) expect(text).not.toContain(row.sealed);
  });

  it('refuses to start with no keyring, before reading any store', async () => {
    const crm = new MemoryStore('crm');
    const list = vi.spyOn(crm, 'list');
    registerSealedStore(crm);
    delete mockEnv.SEALED_SECRET_KEYS;
    delete mockEnv.SEALED_SECRET_ACTIVE_KEY;
    delete mockEnv.SEALED_SECRET_LEGACY_KEY;

    await expect(resealSealedStores()).rejects.toBeInstanceOf(SealedSecretKeyMissingError);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('the registry and the fork init', () => {
  it('runs the fork init before it reads, and walks what it registered', async () => {
    const forkStore = new MemoryStore('fork-crm');
    await forkStore.put('a', 'token-a');
    appInit.impl = () => registerSealedStore(forkStore);
    rotateToNewKey();

    const report = await resealSealedStores();

    expect(report.stores.map((s) => s.store)).toEqual(['fork-crm']);
    expect(forkStore.rows.get('a')!.sealed.startsWith('v2.new.')).toBe(true);
  });

  it('rolls back a throwing init and refuses every reseal until it is fixed', async () => {
    const half = new MemoryStore('registered-before-the-throw');
    appInit.impl = () => {
      registerSealedStore(half);
      throw new Error('fork bug');
    };

    // Not "no stores": the rolled-back registry must not read as an empty one.
    expect(() => getSealedStoreNames()).toThrow(SealedStoreRegistrationError);
    await expect(resealSealedStores()).rejects.toBeInstanceOf(SealedStoreRegistrationError);
    // Latched: the second call still refuses, rather than walking an empty registry.
    await expect(resealSealedStores()).rejects.toBeInstanceOf(SealedStoreRegistrationError);
  });

  it('accepts the same store twice and refuses a different one under its name', () => {
    const store = new MemoryStore('crm');
    registerSealedStore(store);
    registerSealedStore(store);
    expect(() => registerSealedStore(new MemoryStore('crm'))).toThrow(/already registered/);
    expect(getSealedStoreNames()).toEqual(['crm']);
  });

  it('refuses a store with no name', () => {
    expect(() => registerSealedStore(new MemoryStore(''))).toThrow(/needs a name/);
  });
});
