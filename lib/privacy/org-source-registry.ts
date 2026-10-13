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
 * **A failed init is remembered.** If `initAppOrgSources()` throws, the gate
 * rolls back and logs, and {@link appOrgDeclarationsFailed} stays true for the
 * life of the process: `exportOrgData()` then refuses every org rather than
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

/** The core manifest's own floor on a source description (`org-sources.test.ts`). */
const MIN_DESCRIPTION = 20;
/** Matches the subject registry: the reason is what the org reads in place of the table. */
const MIN_REASON = 20;
/** Core's section shape, so a fork section reads like one. */
const SECTION_SHAPE = /^[a-z][A-Za-z0-9]*$/;

function reject(tier: string, model: string, why: string): void {
  // A rejected row is not silently absorbed: the model stays undeclared, so the
  // coverage guard fails naming it. This says why, which the guard cannot.
  logger.error('org-sources: declaration rejected', { tier, model, reason: why });
}

/**
 * Declare the `orgId` models your tier holds, and how the org export reads
 * each. Call from `lib/app/org-export.ts`'s `initAppOrgSources()`. Idempotent
 * by model.
 *
 * A malformed row is dropped with a log rather than throwing — a throw would
 * roll back the tier's valid rows too. The dropped model is then unaccounted
 * for, and the coverage guard fails naming it.
 */
export function registerAppOrgSources(contribution: AppOrgSourceContribution): void {
  const { tier } = contribution;

  for (const source of contribution.sources ?? []) {
    const model = source.model?.trim() ?? '';
    const section = source.section?.trim() ?? '';

    if (model === '') {
      reject(tier, String(source.model), 'model is empty');
      continue;
    }
    if (!SECTION_SHAPE.test(section)) {
      reject(tier, model, `section must match ${String(SECTION_SHAPE)}`);
      continue;
    }
    if (source.disposition !== 'export' && source.disposition !== 'attribution') {
      reject(tier, model, `disposition must be 'export' or 'attribution'`);
      continue;
    }
    if ((source.description ?? '').trim().length < MIN_DESCRIPTION) {
      reject(tier, model, `description must be at least ${MIN_DESCRIPTION} characters`);
      continue;
    }
    if (typeof source.fetch !== 'function') {
      reject(tier, model, 'fetch must be a function');
      continue;
    }

    // A source beats an existing exclusion — between two tiers disagreeing about
    // whether a table is the org's, the one saying it IS keeps `meta` matching
    // the payload. The subject registry's rule, for its reason.
    const supersededExclusion = excluded.get(model);

    const owner = owners.get(model);
    if (owner !== undefined && owner !== tier && supersededExclusion === undefined) {
      reject(tier, model, `already declared by tier '${owner}'`);
      continue;
    }

    // Two models on one section would have one overwrite the other inside the
    // bundle's `app` key — silent loss, with both still counted as declared.
    const collision = [...sources.values()].find(
      (existing) => existing.section === section && existing.model !== model
    );
    if (collision) {
      reject(tier, model, `section '${section}' is already used by ${collision.model}`);
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
    const model = entry.model?.trim() ?? '';

    if (model === '') {
      reject(tier, String(entry.model), 'model is empty');
      continue;
    }
    if ((entry.reason ?? '').trim().length < MIN_REASON) {
      reject(tier, model, `reason must be at least ${MIN_REASON} characters`);
      continue;
    }
    if (sources.has(model)) {
      reject(tier, model, 'already declared as a source — a model is one or the other');
      continue;
    }

    const owner = owners.get(model);
    if (owner !== undefined && owner !== tier) {
      reject(tier, model, `already declared by tier '${owner}'`);
      continue;
    }

    excluded.set(model, { ...entry, model });
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
 * Whether the tier's declarations are unknown because its init threw.
 * `exportOrgData()` refuses while this is true.
 */
export function appOrgDeclarationsFailed(): boolean {
  appInit.ensure();
  return appInitFailed;
}

/** Every declared app-owned org source, in registration order. */
export function getAppOrgSources(): AppOrgDataSource[] {
  appInit.ensure();
  return [...sources.values()];
}

/** Every app-owned `orgId` model declared as deliberately excluded, with its reason. */
export function getAppExcludedOrgSources(): AppExcludedOrgSource[] {
  appInit.ensure();
  return [...excluded.values()];
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
}
