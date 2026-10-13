/**
 * App org-data source registry (§109 t-737) — the fork half of the org
 * export and of its coverage guard.
 *
 * `ORG_DATA_SOURCES` (`lib/privacy/org-sources.ts`) answers "which tables are
 * this org's data?" for core, and `tests/unit/lib/privacy/org-sources.test.ts`
 * holds it level with every `orgId` column in `prisma/schema/*.prisma` — the
 * fork-reserved files included. Before this registry a fork's first `orgId`
 * model could only fail that test or be deleted from it, and `exportOrgData()`
 * had no path for its rows at all. A fork declares here instead; the export
 * reads the declared sources, and the guard unions the declared models into
 * its accounted set, so a fork table keeps the protection rather than being
 * exempted from it.
 *
 * **One shape with core's manifest, `fetch` included.** The subject-export
 * seam splits declaration (a registry) from collection (a static
 * `collectAppSubjectData()`), because the collector came first and a static
 * import was how an unregistered collector was made impossible. Here the
 * registry is the only path, and the lazy init gate runs the fork's
 * statically-imported `initAppOrgSources()` before any read — so an
 * unregistered source is caught by the coverage guard by model name, and a
 * declared source cannot be missing from the bundle, because declaring it is
 * what puts it there. The subject export needs a runtime "every declared
 * section is present" check; this one cannot get into that state.
 *
 * **A failed init, or a rejected declaration, is remembered.** If
 * `initAppOrgSources()` throws, the gate rolls back and logs; if a row is
 * malformed, it is dropped and logged. Either way {@link appOrgDeclarationsFailed}
 * stays true for the life of the process: `exportOrgData()` then refuses every org rather than
 * shipping a bundle without the fork's tables and with nothing saying so. Same
 * call, for the same reason, as `subject-source-registry.ts`.
 *
 * **Two tiers, one registry.** `/app` (leaf) and `/framework` each register
 * with their own `tier`; neither consumes the other's slot. A framework tier is
 * reached from the leaf's `initAppOrgSources()`, not from boot — a registry
 * reset re-runs only the lazy seam.
 *
 * **Realm.** This module imports no Prisma: the declarations carry the fork's
 * `fetch`, but the fork's file is what imports the client. The check that a
 * fork model does not collide with a core manifest model lives in the guard
 * test, because doing it here would import the core manifest and its client.
 *
 * @see lib/app/org-export.ts — the fork-owned scaffold that calls this
 * @see lib/privacy/org-sources.ts — the core manifest this parallels
 * @see lib/privacy/subject-source-registry.ts — the per-person sibling
 * @see .context/privacy/org-export.md — the guide
 */

import { logger } from '@/lib/logging';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { initAppOrgSources } from '@/lib/app/org-export';
import type { SourceDisposition } from '@/lib/privacy/export-sources';
import type { OrgQuery } from '@/lib/privacy/org-sources';

/** One fork-owned model and how the org export reads it. */
export interface AppOrgDataSource {
  /** Prisma model name, exactly as written in your tier's `.prisma` file. The coverage guard matches on this. */
  model: string;
  /** Key this source lands under inside the bundle's `app` section. */
  section: string;
  /**
   * `export` for the org's own records; `attribution` for identity-only rows.
   * Your label: core does not inspect what your `fetch` returns.
   */
  disposition: SourceDisposition;
  /** One line on why this is the org's data — shown in the bundle's `meta.app`. */
  description: string;
  /** Reads the org's rows. Runs as the org; must resolve to an array (`[]` for none). */
  fetch: (org: OrgQuery) => Promise<unknown[]>;
}

/** A fork-owned `orgId` model deliberately left out, with the reason shown in `meta.excluded`. */
export interface AppExcludedOrgSource {
  model: string;
  reason: string;
}

/** One tier's contribution. */
export interface AppOrgSourceContribution {
  /** `'app'`, `'framework'`, or whatever names yours. Diagnostics only. */
  tier: string;
  sources?: readonly AppOrgDataSource[];
  excluded?: readonly AppExcludedOrgSource[];
}

/** Registered sources, keyed by model so a repeat registration is idempotent. */
const sources = new Map<string, AppOrgDataSource>();
/** Registered exclusions, keyed by model. */
const excluded = new Map<string, AppExcludedOrgSource>();
/** Which tier registered each model, for the duplicate-across-tiers message. */
const owners = new Map<string, string>();

/** Whether the app init threw, leaving this tier's declarations unknown. */
let appInitFailed = false;
/**
 * Rejected rows, kept so a read can tell whether one left a table uncovered.
 * A rejected source is not in the bundle, and the coverage guard catches that
 * only for a model carrying an `orgId` column — a hand-listed child table
 * (core's `Verification` precedent) would vanish with nothing but a log line.
 * A rejection that loses nothing (another tier already exports the model)
 * does not count; see {@link declarationsIncomplete}.
 */
const rejectedSources = new Set<string>();
const rejectedExclusions = new Set<string>();
/** A row rejected before it named a model, so what it covered is unknowable. */
let unidentifiedRejection = false;

/** The core manifest's own floor on a source description: longer than 20 (`org-sources.test.ts`). */
const MIN_DESCRIPTION = 21;
/** Matches the subject registry: the reason is what the org reads in place of the table. */
const MIN_REASON = 20;
/** Core's section shape, so a fork section reads like one. */
const SECTION_SHAPE = /^[a-z][A-Za-z0-9]*$/;

/**
 * Whether a section name is a built-in member of every object (`toString`,
 * `constructor`, `hasOwnProperty`…). It passes the shape, and as a key of the
 * bundle's `app` object it would replace that member with an array, so an
 * in-process reader calling `bundle.app.hasOwnProperty(…)` would throw.
 */
function isObjectBuiltin(section: string): boolean {
  return section in Object.prototype;
}

/** A field's trimmed text, or `''` when it is not a string — a fork's JS can pass anything. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

type RowKind = 'source' | 'exclusion';

/**
 * Drop a row with a log, and remember it. `model` is `null` when the row named
 * none. The export refuses if the rejection left a table uncovered, because
 * the coverage guard cannot see a table without an `orgId` column.
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
  logger.error('org-sources: declaration rejected', { tier, model: label, reason: why });
}

/**
 * Whether a rejected row left something the fork declared out of the export:
 * a rejected source whose model no tier exports, a rejected exclusion whose
 * model nobody accounted for, or a row that named no model at all.
 */
function declarationsIncomplete(): boolean {
  if (unidentifiedRejection) return true;
  for (const model of rejectedSources) if (!sources.has(model)) return true;
  for (const model of rejectedExclusions) {
    if (!sources.has(model) && !excluded.has(model)) return true;
  }
  return false;
}

/** A loggable label for any field value — never throws, whatever a fork's JS passed. */
function labelOf(value: unknown): string {
  return typeof value === 'string' ? value : describeNonEntry(value);
}

/** A loggable label for a non-object entry: `null`, or its type. */
function describeNonEntry(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

/** Whether an entry is an object at all — `null` or a stray value from a fork's JS is not. */
function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Declare the `orgId` models your tier holds, and how the org export reads
 * each. Call from `lib/app/org-export.ts`'s `initAppOrgSources()`. Idempotent
 * by model.
 *
 * A malformed row is dropped with a log rather than throwing — a throw would
 * roll back the tier's valid rows too. The dropped model is then unaccounted
 * for, so the coverage guard fails naming it, and `exportOrgData()` refuses
 * until the row is fixed: a bundle short by a declared table is not shipped.
 */
export function registerAppOrgSources(contribution: AppOrgSourceContribution): void {
  const { tier } = contribution;

  for (const source of contribution.sources ?? []) {
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
    if (!SECTION_SHAPE.test(section)) {
      reject(tier, 'source', model, model, `section must match ${String(SECTION_SHAPE)}`);
      continue;
    }
    if (isObjectBuiltin(section)) {
      reject(tier, 'source', model, model, `section '${section}' is a built-in object member`);
      continue;
    }
    if (source.disposition !== 'export' && source.disposition !== 'attribution') {
      reject(tier, 'source', model, model, `disposition must be 'export' or 'attribution'`);
      continue;
    }
    if (text(source.description).length < MIN_DESCRIPTION) {
      reject(
        tier,
        'source',
        model,
        model,
        `description must be at least ${MIN_DESCRIPTION} characters`
      );
      continue;
    }
    if (typeof source.fetch !== 'function') {
      reject(tier, 'source', model, model, 'fetch must be a function');
      continue;
    }

    // A source beats an existing exclusion — between two tiers disagreeing about
    // whether a table is the org's, the one saying it IS keeps `meta` matching
    // the payload. The subject registry's rule, for its reason.
    const supersededExclusion = excluded.get(model);

    const owner = owners.get(model);
    if (owner !== undefined && owner !== tier && supersededExclusion === undefined) {
      reject(tier, 'source', model, model, `already declared by tier '${owner}'`);
      continue;
    }

    // Two models on one section would have one overwrite the other inside the
    // bundle's `app` key — silent loss, with both still counted as declared.
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

    // Supersede only once the row is certain to be accepted, so a rejected
    // source cannot destroy a valid exclusion on its way past.
    if (supersededExclusion) {
      excluded.delete(model);
      logger.warn('org-sources: a source declaration replaced an exclusion', {
        tier,
        model,
        previousOwner: owner,
        previousReason: supersededExclusion.reason,
      });
    }

    sources.set(model, { ...source, model, section });
    owners.set(model, tier);
  }

  for (const entry of contribution.excluded ?? []) {
    if (!isEntry(entry)) {
      reject(tier, 'exclusion', null, describeNonEntry(entry), 'exclusion is not an object');
      continue;
    }
    const model = text(entry.model);

    if (model === '') {
      reject(tier, 'exclusion', null, labelOf(entry.model), 'model is empty');
      continue;
    }
    if (text(entry.reason).length < MIN_REASON) {
      reject(tier, 'exclusion', model, model, `reason must be at least ${MIN_REASON} characters`);
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

    // Exactly the two fields, trimmed: this object is what the org's bundle
    // shows in `meta.excluded`, so nothing else a fork passed may ride along.
    excluded.set(model, { model, reason: text(entry.reason) });
    owners.set(model, tier);
  }
}

/** Run the fork's init once, lazily, all-or-nothing — see `lib/fork-init.ts`. */
const appInit = createAppInitGate({
  label: 'org-sources: initAppOrgSources',
  subject: 'app org-source declarations',
  init: initAppOrgSources,
  snapshot: () => ({
    sources: new Map(sources),
    excluded: new Map(excluded),
    owners: new Map(owners),
  }),
  restore: (before) => {
    restoreMap(sources, before.sources);
    restoreMap(excluded, before.excluded);
    restoreMap(owners, before.owners);
  },
  // From `onFailure`, not from `ensure()`'s verdict: a re-entrant read during a
  // successful init returns 'running', and reading that as failure would latch
  // a refusal for the life of the process (the subject registry's lesson).
  onFailure: () => {
    appInitFailed = true;
  },
});

/**
 * Whether the tier's declarations are unknown or incomplete — its init threw,
 * or a declaration was rejected. `exportOrgData()` refuses while this is true.
 */
export function appOrgDeclarationsFailed(): boolean {
  appInit.ensure();
  return appInitFailed || declarationsIncomplete();
}

/** Every declared app-owned org source, in registration order. */
export function getAppOrgSources(): AppOrgDataSource[] {
  appInit.ensure();
  return [...sources.values()];
}

/** Every app-owned `orgId` model declared as deliberately excluded, with its reason. */
export function getAppExcludedOrgSources(): AppExcludedOrgSource[] {
  appInit.ensure();
  return [...excluded.values()].map((entry) => ({ ...entry }));
}

/** Every app-owned model some tier accounted for — what the coverage guard unions in. */
export function getAccountedAppOrgModels(): Set<string> {
  appInit.ensure();
  return new Set([...sources.keys(), ...excluded.keys()]);
}

/** Test-only: clear the registry and re-arm the one-shot app init. */
export function __resetAppOrgSourceRegistryForTests(): void {
  sources.clear();
  excluded.clear();
  owners.clear();
  appInit.reset();
  appInitFailed = false;
  rejectedSources.clear();
  rejectedExclusions.clear();
  unidentifiedRejection = false;
}
