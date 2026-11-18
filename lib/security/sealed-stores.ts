/**
 * Sealed stores: every place that keeps sealed secrets, so retiring a master
 * key is one command and not a hunt (§137 t-1043).
 *
 * A key can be removed from `SEALED_SECRET_KEYS` only once nothing is still
 * sealed under it. Only the code that wrote a value knows where it is, so
 * each store registers here how to list its values and how to replace one,
 * and {@link resealSealedStores} (run as `npm run secrets:reseal`) opens
 * every value not yet under the active key and seals it again under that
 * key. The store owns the queries; this module owns the walk.
 *
 * A fork registers its own stores from `lib/app/sealed-stores.ts`. Sunrise's
 * own stores are registered here, in code, as they are added.
 *
 * ## What the walk guarantees
 *
 * - **Idempotent.** A value already under the active key is not touched, so
 *   a second run writes nothing.
 * - **Safe on empty.** No stores, or stores with no values: a report of
 *   zeros, not an error.
 * - **Never overwrites a newer value.** `replace` is a compare-and-swap: a
 *   store writes only if the row still holds the envelope that was read. A
 *   value someone saved meanwhile was sealed under the active key already,
 *   and is counted as `changedMeanwhile`, not failed.
 * - **Reports, never hides.** A value that will not open is listed by its id
 *   with the reason, and the run is not `ok`. It is not rewritten, so the
 *   key it needs must not be removed yet.
 * - **Refuses when a fork's registration failed.** A walk that skipped a
 *   fork's stores would report `ok` while values were still sealed under the
 *   old key, and removing that key would make them unreadable. So a failed
 *   `initAppSealedStores` makes the walk throw until it is fixed.
 * - **Nothing secret leaves it.** The report holds counts, row ids and reason
 *   codes, never a plaintext or an envelope.
 *
 * Each store's walk runs inside `runAsSystem`: re-keying is install-wide, and
 * at `multi` a store's rows belong to every org.
 *
 * Tenancy posture: global-config — the store registry is process-wide and
 * filled from code (lib/tenancy/process-state.ts).
 *
 * @see lib/security/sealed-secrets.ts — the envelope and the keyring
 * @see lib/app/sealed-stores.ts — where a fork registers its stores
 * @see .context/security/sealed-secrets.md
 */

import { initAppSealedStores } from '@/lib/app/sealed-stores';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import {
  activeSealedSecretKeyId,
  needsReseal,
  openSecret,
  sealSecret,
  SealedSecretOpenError,
  type SealedSecretOpenFailure,
} from '@/lib/security/sealed-secrets';
import { runAsSystem } from '@/lib/tenancy/context';

/** One stored value, as a store lists it. */
export interface SealedValue {
  /** The row's id, which the report names. Not secret. */
  id: string;
  /** The envelope as stored. */
  sealed: string;
  /** The purpose it was sealed for. */
  purpose: string;
}

/** A place that keeps sealed secrets. */
export interface SealedStore {
  /** Unique, and what the report calls it, e.g. `'crm-credentials'`. */
  name: string;
  /**
   * Every value the store holds. Page through the table rather than loading it
   * at once; the walk reads one value at a time.
   */
  list(): AsyncIterable<SealedValue>;
  /**
   * Store `next` for row `id`, but only if the row still holds `previous`.
   * Answer whether it wrote. A row that changed or went away answers `false`.
   */
  replace(id: string, previous: string, next: string): Promise<boolean>;
}

/** What the walk did to one store. */
export interface SealedStoreResealResult {
  store: string;
  /** Values listed. */
  scanned: number;
  /** Values already under the active key, left alone. */
  alreadyCurrent: number;
  /** Values moved onto the active key (or, on a dry run, that would be). */
  resealed: number;
  /** Values replaced by someone else between the read and the write. */
  changedMeanwhile: number;
  /** Values that could not be moved, by row id. */
  failed: Array<{ id: string; reason: SealedSecretOpenFailure | 'write_failed' }>;
  /** Set when listing the store threw; its counts stop where it did. */
  error?: string;
}

export interface SealedStoresResealReport {
  dryRun: boolean;
  /** The key every value was moved onto. */
  activeKeyId: string;
  stores: SealedStoreResealResult[];
  /** Every store walked to the end, and every value is now on the active key. */
  ok: boolean;
}

/** `initAppSealedStores` threw, so the registry may be missing a fork's stores. */
export class SealedStoreRegistrationError extends Error {
  constructor() {
    super(
      'lib/app/sealed-stores.ts threw in initAppSealedStores, so this app’s sealed stores are not registered. ' +
        'Resealing is refused until it is fixed: a reseal that skipped them would leave values under a key you might then remove.'
    );
    this.name = 'SealedStoreRegistrationError';
  }
}

const stores = new Map<string, SealedStore>();
let registrationFailed = false;

const appInit = createAppInitGate({
  label: 'sealed-stores: initAppSealedStores',
  subject: 'the app’s sealed stores',
  init: initAppSealedStores,
  snapshot: () => new Map(stores),
  restore: (before) => restoreMap(stores, before),
  onFailure: () => {
    registrationFailed = true;
  },
});

/**
 * Register a store. Re-registering the same object under its name is a
 * no-op; a different store under a taken name throws, because one of the two
 * would silently never be resealed.
 *
 * @throws if `name` is empty or already taken by another store.
 */
export function registerSealedStore(store: SealedStore): void {
  if (typeof store.name !== 'string' || store.name.length === 0) {
    throw new Error('registerSealedStore: a sealed store needs a name');
  }
  const existing = stores.get(store.name);
  if (existing && existing !== store) {
    throw new Error(
      `registerSealedStore: a different store is already registered as "${store.name}"`
    );
  }
  stores.set(store.name, store);
}

/** The registered stores' names, in registration order. Runs the fork init first. */
export function getSealedStoreNames(): string[] {
  appInit.ensure();
  return [...stores.keys()];
}

/** Test-only: clear the registry and re-arm the fork init. */
export function __resetSealedStoresForTests(): void {
  stores.clear();
  registrationFailed = false;
  appInit.reset();
}

/**
 * Move every registered store's values onto the active key. With `dryRun`,
 * count what would move and write nothing.
 *
 * @throws SealedSecretKeyMissingError when no keyring is configured.
 * @throws SealedStoreRegistrationError when the fork's registration failed.
 */
export async function resealSealedStores(
  options: { dryRun?: boolean } = {}
): Promise<SealedStoresResealReport> {
  const dryRun = options.dryRun ?? false;
  appInit.ensure();
  if (registrationFailed) throw new SealedStoreRegistrationError();
  // Throws SealedSecretKeyMissingError before any store is read.
  const activeKeyId = activeSealedSecretKeyId();

  const results: SealedStoreResealResult[] = [];
  for (const store of stores.values()) {
    results.push(
      await runAsSystem(`reseal sealed secrets: ${store.name}`, () => resealStore(store, dryRun))
    );
  }
  return {
    dryRun,
    activeKeyId,
    stores: results,
    ok: results.every((r) => r.error === undefined && r.failed.length === 0),
  };
}

async function resealStore(store: SealedStore, dryRun: boolean): Promise<SealedStoreResealResult> {
  const result: SealedStoreResealResult = {
    store: store.name,
    scanned: 0,
    alreadyCurrent: 0,
    resealed: 0,
    changedMeanwhile: 0,
    failed: [],
  };
  try {
    for await (const value of store.list()) {
      result.scanned += 1;
      if (!needsReseal(value.sealed)) {
        result.alreadyCurrent += 1;
        continue;
      }

      let plaintext: string;
      try {
        plaintext = await openSecret(value.sealed, value.purpose);
      } catch (err) {
        if (err instanceof SealedSecretOpenError) {
          result.failed.push({ id: value.id, reason: err.reason });
          continue;
        }
        throw err;
      }

      if (dryRun) {
        result.resealed += 1;
        continue;
      }

      const next = await sealSecret(plaintext, value.purpose);
      let wrote: boolean;
      try {
        wrote = await store.replace(value.id, value.sealed, next);
      } catch {
        result.failed.push({ id: value.id, reason: 'write_failed' });
        continue;
      }
      if (wrote) result.resealed += 1;
      else result.changedMeanwhile += 1;
    }
  } catch (err) {
    // A store whose listing broke is reported and the walk moves on: the
    // other stores' values still need moving. The run is then not `ok`.
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
