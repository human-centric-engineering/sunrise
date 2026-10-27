/**
 * Declaration registry — the shared core of the two fork export seams (t-787).
 *
 * `subject-source-registry.ts` (Art. 15, per person) and
 * `org-source-registry.ts` (§109, per org) answer the same question for their
 * export: which fork-owned models a tier declares, and which it deliberately
 * leaves out. The org registry was first written as a copy of the subject one,
 * and the copies had already drifted — the subject side threw on a non-string
 * `model` or a `null` entry, which rolled its whole tier back and left Art. 15
 * refusing for the life of the process. The org side had been hardened against
 * exactly that. One implementation means a fix lands in both.
 *
 * **What is shared, and is not an option:**
 *
 *  - Every field is type-checked before it is read. A fork's JS, or a value
 *    read from config, has no type protection, and a throw here takes the
 *    tier's valid rows down with it.
 *  - A source beats an exclusion; the exclusion is removed only once the
 *    source is certain to be accepted.
 *  - One owner per model across tiers, and one model per section.
 *  - An exclusion is stored as exactly `{ model, reason }`, trimmed, and read
 *    out as copies. It is shown to whoever receives the bundle in
 *    `meta.excluded`, so nothing else a fork passed may ride along with it.
 *
 * **What differs per seam** is in {@link DeclarationRegistryOptions}, each
 * option with the reason it differs.
 *
 * **The init gate stays in each seam's own file.** `fork-init-seams.test.ts`
 * requires the file that imports an `initApp*` seam to run it through
 * `createAppInitGate` itself, so this factory hands out the snapshot, restore
 * and failure hooks the gate needs instead of owning one.
 *
 * **Realm.** Plain data and a logger: no Prisma, so `lib/app/**` may reach the
 * seams built on it.
 *
 * @see lib/privacy/subject-source-registry.ts
 * @see lib/privacy/org-source-registry.ts
 */

import { logger } from '@/lib/logging';
import { restoreMap } from '@/lib/fork-init';
import type { SourceDisposition } from '@/lib/privacy/export-sources';

/** The fields every declared source carries, whichever export it is for. */
export interface DeclaredSource {
  model: string;
  section: string;
  disposition: SourceDisposition;
  description: string;
}

/** A model a tier deliberately leaves out, with the reason shown in `meta.excluded`. */
export interface DeclaredExclusion {
  model: string;
  reason: string;
}

/** One tier's contribution. */
export interface DeclarationContribution<S extends DeclaredSource> {
  /**
   * Which tier is declaring — `'app'` for a leaf fork, `'framework'` for a
   * framework tier, or whatever names yours. Used only in diagnostics, so that
   * a rejected row says who tried to register it.
   */
  tier: string;
  sources?: readonly S[];
  excluded?: readonly DeclaredExclusion[];
}

/** The per-seam rules. Everything not here is the same for both exports. */
export interface DeclarationRegistryOptions<S extends DeclaredSource> {
  /** Prefixes every log line, e.g. `'subject-sources'`. */
  logPrefix: string;
  /**
   * Shortest description accepted, matching the floor the seam's CORE manifest
   * test puts on its own sources: 10 for the subject manifest
   * (`export-sources.test.ts`), more than 20 for the org one
   * (`org-sources.test.ts`). A fork row is held to the bar core holds itself to.
   */
  minDescription: number;
  /**
   * Why a section name is refused, or `null` to accept it.
   *
   * Different because the two `app` objects are built by different code. The
   * org export builds its `app` from the declarations, so a section is a key
   * core writes — it gets core's shape and no `Object.prototype` names. The
   * subject export's `app` is whatever the fork's `collectAppSubjectData()`
   * returns, so core already checks it with `Object.hasOwn` and only needs a
   * name. Tightening that one would refuse sections forks already ship, with
   * nothing protected by it.
   */
  checkSection: (section: string) => string | null;
  /** A seam-specific check on a source that passed the shared ones, e.g. the org `fetch`. */
  checkSource?: (source: S) => string | null;
  /**
   * Whether a rejected row that left a model uncovered makes {@link DeclarationRegistry.failed}
   * true, so the export refuses.
   *
   * Different because rejecting a row loses different things. An org source
   * is its own `fetch`: rejecting it removes the table from the bundle, and
   * the coverage guard cannot see a table without an `orgId` column. A subject
   * source only describes rows that `collectAppSubjectData()` returns anyway,
   * so the payload is still complete and the coverage guard names the model at
   * build time. Refusing an access request over that would withhold the answer
   * without making it any more complete.
   */
  rejectionsLatch: boolean;
}

/** What the init gate snapshots before the fork's init and restores on a throw. */
export interface DeclarationSnapshot<S extends DeclaredSource> {
  sources: Map<string, S>;
  excluded: Map<string, DeclaredExclusion>;
  owners: Map<string, string>;
  rejectedSources: Set<string>;
  rejectedExclusions: Set<string>;
  unidentifiedRejection: boolean;
}

export interface DeclarationRegistry<S extends DeclaredSource> {
  /** Validate and record a tier's contribution. Never throws on a malformed row. */
  register: (contribution: DeclarationContribution<S>) => void;
  /** Every declared source, in registration order. */
  sources: () => S[];
  /** Every declared exclusion, as copies. */
  excluded: () => DeclaredExclusion[];
  /** Every model some tier accounted for — exported or excluded. */
  accounted: () => Set<string>;
  /** Whether the export must refuse: the init threw, or (if latching) a rejection lost a model. */
  failed: () => boolean;
  /** For the init gate: copy the registry's contents. */
  snapshot: () => DeclarationSnapshot<S>;
  /** For the init gate: put copied contents back. */
  restore: (before: DeclarationSnapshot<S>) => void;
  /** For the init gate's `onFailure`: remember that the fork's init threw. */
  markInitFailed: () => void;
  /** Test-only: clear everything, including a latched failure. */
  reset: () => void;
}

/** Shortest exclusion reason accepted. The reason is what the reader gets in place of the table. */
export const MIN_EXCLUSION_REASON = 20;

/** A field's trimmed text, or `''` when it is not a string — a fork's JS can pass anything. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A loggable label for a non-object entry: `null`, or its type. */
function describeNonEntry(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

/** A loggable label for any field value — never throws, whatever a fork's JS passed. */
function labelOf(value: unknown): string {
  return typeof value === 'string' ? value : describeNonEntry(value);
}

/** Whether an entry is an object at all — `null` or a stray value from a fork's JS is not. */
function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `Array.isArray` without its `any[]` narrowing, which would erase the row type. */
function isList<T>(value: readonly T[]): value is readonly T[] {
  return Array.isArray(value);
}

type RowKind = 'source' | 'exclusion';

/** Build one seam's registry. Call once at module scope. */
export function createDeclarationRegistry<S extends DeclaredSource>(
  options: DeclarationRegistryOptions<S>
): DeclarationRegistry<S> {
  const { logPrefix, minDescription, checkSection, checkSource, rejectionsLatch } = options;

  /** Registered sources, keyed by model so a repeat registration is idempotent. */
  const sources = new Map<string, S>();
  /** Registered exclusions, keyed by model. */
  const excluded = new Map<string, DeclaredExclusion>();
  /** Which tier registered each model, for the duplicate-across-tiers message. */
  const owners = new Map<string, string>();
  /** Rejected rows by model, so {@link incomplete} can tell whether one left a table uncovered. */
  const rejectedSources = new Set<string>();
  const rejectedExclusions = new Set<string>();
  /** A row rejected before it named a model, so what it covered is unknowable. */
  let unidentifiedRejection = false;
  /** Whether the fork's init threw, leaving the tier's declarations unknown. */
  let initFailed = false;

  /**
   * Drop a row with a log, and remember it. `model` is `null` when the row
   * named none. The dropped model stays unaccounted, so the coverage guard
   * fails naming it; the log says why, which the guard cannot know.
   */
  function reject(
    tier: string,
    kind: RowKind,
    model: string | null,
    label: string,
    why: string
  ): void {
    if (model === null) unidentifiedRejection = true;
    else (kind === 'source' ? rejectedSources : rejectedExclusions).add(model);
    logger.error(`${logPrefix}: declaration rejected`, { tier, model: label, reason: why });
  }

  /**
   * Whether a rejected row left something out: a rejected source whose model
   * no tier exports, a rejected exclusion whose model nobody accounted for, or
   * a row that named no model. A rejection that lost nothing (another tier
   * already exports the model) does not count.
   */
  function incomplete(): boolean {
    if (unidentifiedRejection) return true;
    for (const model of rejectedSources) if (!sources.has(model)) return true;
    for (const model of rejectedExclusions) {
      if (!sources.has(model) && !excluded.has(model)) return true;
    }
    return false;
  }

  /**
   * A contribution's row list, or `[]` with a rejection when it is not an
   * array. `?? []` alone would let an object through to `for...of`, and that
   * throw escapes the init and rolls the whole tier back.
   */
  function rowsOf<T>(tier: string, kind: RowKind, value: readonly T[] | undefined): readonly T[] {
    if (value === undefined || value === null) return [];
    if (!isList(value)) {
      reject(tier, kind, null, describeNonEntry(value), `${kind} list is not an array`);
      return [];
    }
    return value;
  }

  function register(contribution: DeclarationContribution<S>): void {
    // The container is checked like its rows: it comes from the same fork JS.
    if (!isEntry(contribution)) {
      reject('', 'source', null, describeNonEntry(contribution), 'contribution is not an object');
      return;
    }
    // `tier` keys `owners`. A non-string one stored as `undefined` reads back
    // as "no owner", and a second tier's duplicate of the model would pass.
    const { tier } = contribution;
    if (typeof tier !== 'string') {
      reject(labelOf(tier), 'source', null, labelOf(tier), 'tier is not a string');
      return;
    }

    for (const source of rowsOf(tier, 'source', contribution.sources)) {
      if (!isEntry(source)) {
        reject(tier, 'source', null, describeNonEntry(source), 'source is not an object');
        continue;
      }
      const model = text(source.model);
      const section = text(source.section);

      if (model === '') {
        reject(tier, 'source', null, labelOf(source.model), 'model is empty');
        continue;
      }
      const badSection = checkSection(section);
      if (badSection !== null) {
        reject(tier, 'source', model, model, badSection);
        continue;
      }
      if (source.disposition !== 'export' && source.disposition !== 'attribution') {
        reject(tier, 'source', model, model, `disposition must be 'export' or 'attribution'`);
        continue;
      }
      const description = text(source.description);
      if (description.length < minDescription) {
        reject(
          tier,
          'source',
          model,
          model,
          `description must be at least ${minDescription} characters`
        );
        continue;
      }
      const badSource = checkSource?.(source) ?? null;
      if (badSource !== null) {
        reject(tier, 'source', model, model, badSource);
        continue;
      }

      // A source BEATS an existing exclusion, rather than being refused.
      //
      // Refusing left a model that could never move from `excluded` to
      // `sources`: a framework tier excluding `SharedTag`, and a leaf later
      // declaring it a source, produced a rejected source, a still-"accounted"
      // model, a green coverage guard — and a bundle whose `meta.excluded` said
      // the table was withheld while its rows may well have been in it. Between
      // two tiers disagreeing about whether a table is the subject's data, the
      // one saying it IS keeps `meta` matching the payload.
      const supersededExclusion = excluded.get(model);

      const owner = owners.get(model);
      if (owner !== undefined && owner !== tier && supersededExclusion === undefined) {
        reject(tier, 'source', model, model, `already declared by tier '${owner}'`);
        continue;
      }

      // Two models on one section would have one overwrite the other inside
      // the bundle's `app` key — silent loss, with both still counted as declared.
      const collision = [...sources.values()].find(
        (existing) => existing.section === section && existing.model !== model
      );
      if (collision) {
        reject(
          tier,
          'source',
          model,
          model,
          `section '${section}' is already used by ${collision.model}`
        );
        continue;
      }

      // Supersede only once the row is certain to be accepted. Deleting it
      // earlier let a source then rejected by the collision check take a valid
      // exclusion with it, and `meta.excluded` stopped saying the table was
      // withheld and why.
      if (supersededExclusion) {
        excluded.delete(model);
        logger.warn(`${logPrefix}: a source declaration replaced an exclusion`, {
          tier,
          model,
          previousOwner: owner,
          previousReason: supersededExclusion.reason,
        });
      }

      // Stored trimmed, as checked: the description is shown in `meta.app`.
      sources.set(model, { ...source, model, section, description });
      owners.set(model, tier);
    }

    for (const entry of rowsOf(tier, 'exclusion', contribution.excluded)) {
      if (!isEntry(entry)) {
        reject(tier, 'exclusion', null, describeNonEntry(entry), 'exclusion is not an object');
        continue;
      }
      const model = text(entry.model);
      const reason = text(entry.reason);

      if (model === '') {
        reject(tier, 'exclusion', null, labelOf(entry.model), 'model is empty');
        continue;
      }
      if (reason.length < MIN_EXCLUSION_REASON) {
        // The reason is the whole value of an exclusion, and it is not filing:
        // the export puts it in the bundle's `meta.excluded`, so it is what the
        // reader — and any regulator auditing the response — is shown in place
        // of the table's contents.
        reject(
          tier,
          'exclusion',
          model,
          model,
          `reason must be at least ${MIN_EXCLUSION_REASON} characters`
        );
        continue;
      }
      if (sources.has(model)) {
        reject(
          tier,
          'exclusion',
          model,
          model,
          'already declared as a source — a model is one or the other'
        );
        continue;
      }

      const owner = owners.get(model);
      if (owner !== undefined && owner !== tier) {
        reject(tier, 'exclusion', model, model, `already declared by tier '${owner}'`);
        continue;
      }

      excluded.set(model, { model, reason });
      owners.set(model, tier);
    }
  }

  return {
    register,
    sources: () => [...sources.values()],
    excluded: () => [...excluded.values()].map((entry) => ({ ...entry })),
    accounted: () => new Set([...sources.keys(), ...excluded.keys()]),
    failed: () => initFailed || (rejectionsLatch && incomplete()),
    snapshot: () => ({
      sources: new Map(sources),
      excluded: new Map(excluded),
      owners: new Map(owners),
      rejectedSources: new Set(rejectedSources),
      rejectedExclusions: new Set(rejectedExclusions),
      unidentifiedRejection,
    }),
    restore: (before) => {
      restoreMap(sources, before.sources);
      restoreMap(excluded, before.excluded);
      restoreMap(owners, before.owners);
      rejectedSources.clear();
      for (const model of before.rejectedSources) rejectedSources.add(model);
      rejectedExclusions.clear();
      for (const model of before.rejectedExclusions) rejectedExclusions.add(model);
      unidentifiedRejection = before.unidentifiedRejection;
    },
    markInitFailed: () => {
      initFailed = true;
    },
    reset: () => {
      sources.clear();
      excluded.clear();
      owners.clear();
      rejectedSources.clear();
      rejectedExclusions.clear();
      unidentifiedRejection = false;
      initFailed = false;
    },
  };
}
