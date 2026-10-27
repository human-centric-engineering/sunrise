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

import { createAppInitGate } from '@/lib/fork-init';
import { initAppOrgSources } from '@/lib/app/org-export';
import {
  createDeclarationRegistry,
  type DeclarationContribution,
  type DeclaredExclusion,
} from '@/lib/privacy/declaration-registry';
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
export type AppExcludedOrgSource = DeclaredExclusion;

/** One tier's contribution. */
export type AppOrgSourceContribution = DeclarationContribution<AppOrgDataSource>;

/** Core's section shape, so a fork section reads like one. */
const SECTION_SHAPE = /^[a-z][A-Za-z0-9]*$/;

/** Shared rules; see `declaration-registry.ts` for which differ per seam and why. */
const registry = createDeclarationRegistry<AppOrgDataSource>({
  logPrefix: 'org-sources',
  // The core manifest's own floor on a source description: longer than 20 (`org-sources.test.ts`).
  minDescription: 21,
  checkSection: (section) => {
    if (!SECTION_SHAPE.test(section)) return `section must match ${String(SECTION_SHAPE)}`;
    // A built-in member of every object (`toString`, `constructor`…) passes the
    // shape, and as a key of the bundle's `app` object it would replace that
    // member with an array, so an in-process reader calling
    // `bundle.app.hasOwnProperty(…)` would throw.
    if (section in Object.prototype) return `section '${section}' is a built-in object member`;
    return null;
  },
  checkSource: (source) => (typeof source.fetch !== 'function' ? 'fetch must be a function' : null),
  // A rejected source is a table missing from the bundle, and the coverage
  // guard sees only models with an `orgId` column — so the export refuses.
  rejectionsLatch: true,
});

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
  registry.register(contribution);
}

/** Run the fork's init once, lazily, all-or-nothing — see `lib/fork-init.ts`. */
const appInit = createAppInitGate({
  label: 'org-sources: initAppOrgSources',
  subject: 'app org-source declarations',
  init: initAppOrgSources,
  snapshot: registry.snapshot,
  restore: registry.restore,
  // From `onFailure`, not from `ensure()`'s verdict: a re-entrant read during a
  // successful init returns 'running', and reading that as failure would latch
  // a refusal for the life of the process (the subject registry's lesson).
  onFailure: registry.markInitFailed,
});

/**
 * Whether the tier's declarations are unknown or incomplete — its init threw,
 * or a declaration was rejected. `exportOrgData()` refuses while this is true.
 */
export function appOrgDeclarationsFailed(): boolean {
  appInit.ensure();
  return registry.failed();
}

/** Every declared app-owned org source, in registration order. */
export function getAppOrgSources(): AppOrgDataSource[] {
  appInit.ensure();
  return registry.sources();
}

/** Every app-owned `orgId` model declared as deliberately excluded, with its reason. */
export function getAppExcludedOrgSources(): AppExcludedOrgSource[] {
  appInit.ensure();
  return registry.excluded();
}

/** Every app-owned model some tier accounted for — what the coverage guard unions in. */
export function getAccountedAppOrgModels(): Set<string> {
  appInit.ensure();
  return registry.accounted();
}

/** Test-only: clear the registry and re-arm the one-shot app init. */
export function __resetAppOrgSourceRegistryForTests(): void {
  registry.reset();
  appInit.reset();
}
