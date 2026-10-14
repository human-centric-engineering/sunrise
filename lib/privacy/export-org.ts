/**
 * Org data export (§106 t-672) — "give us our data" for a customer being
 * offboarded, the org-subject counterpart of `exportUserData()`.
 *
 * Assembles one org's record into a single JSON bundle: the org row, every
 * table that holds the org's own data, and the credentials it holds. Like the
 * subject export it decides nothing about *which* tables — it walks
 * {@link ORG_DATA_SOURCES}, the manifest a build-breaking test holds level
 * with every `orgId` column in `prisma/schema/*.prisma`.
 *
 * **A partial export is worse than no export.** Any source that throws fails
 * the whole export; nothing is best-effort. Same asymmetry with `eraseOrg()`
 * as between the two per-person services, for the same reason: only the
 * export failure is invisible to the person receiving it.
 *
 * The org is not a data subject, so no receipt is written and no `reason` is
 * required — the actor is logged, which is what an operator action needs.
 *
 * **It authorises nothing.** It reads the org it is given, as that org
 * (`runAsOrg`, t-735), whoever calls it, so the caller decides who may export
 * which org. Today that is one route, platform admins only. A caller for an
 * org's own owner (§111) must check the requester administers the org it was
 * asked for, not just their active one, or this becomes a cross-tenant read.
 *
 * **A fork's own tables** (§109 t-737) come from
 * `lib/privacy/org-source-registry.ts`, filled by the fork's
 * `lib/app/org-export.ts`. They are read after core's, as the same org, and
 * land under the bundle's `app` key with a summary in `meta.app` — both absent
 * when nothing is registered, so a vanilla install's bundle is unchanged.
 *
 * @see lib/privacy/org-sources.ts — the manifest and its coverage guard
 * @see lib/privacy/org-source-registry.ts — the fork half of it
 * @see lib/privacy/erase-org.ts — the deletion this precedes
 * @see lib/privacy/export-user.ts — the per-person shape this mirrors
 * @see .context/privacy/org-export.md — the guide
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { runAsOrg } from '@/lib/tenancy/context';
import { runAcrossOwners } from '@/lib/auth/subject-context';
import {
  ORG_DATA_SOURCES,
  ORG_EXCLUDED_SOURCES,
  type OrgExcludedSource,
  type OrgQuery,
} from '@/lib/privacy/org-sources';
import {
  appOrgDeclarationsFailed,
  getAppExcludedOrgSources,
  getAppOrgSources,
} from '@/lib/privacy/org-source-registry';
import type { SourceDisposition } from '@/lib/privacy/export-sources';
import type { ExportedSourceSummary } from '@/lib/privacy/export-user';

/**
 * Bundle format version. Bump on any breaking change to the shape below —
 * separate from the subject bundle's version because the two bundles have
 * different readers.
 */
export const ORG_EXPORT_FORMAT_VERSION = 1;

export interface ExportOrgParams {
  /** Id of the org to export. */
  orgId: string;
  /** Who asked — the platform admin acting on the customer's request. */
  actorUserId: string;
}

export interface OrgExportMeta {
  formatVersion: number;
  generatedAt: string;
  orgId: string;
  /** Sources returned in full, with row counts. Sections of `data`. */
  exported: ExportedSourceSummary[];
  /** Sources returned as id + label + date only. Sections of `attributions`. */
  attribution: ExportedSourceSummary[];
  /** Tables deliberately left out, with the reason — core's, then a fork's. */
  excluded: OrgExcludedSource[];
  /**
   * A fork's sources, with row counts and the disposition the fork declared.
   * Sections of `app`. Present only when a fork registered a source.
   */
  app?: AppOrgSourceSummary[];
}

/** A fork source's summary: core's shape plus the fork's own disposition label. */
export interface AppOrgSourceSummary extends ExportedSourceSummary {
  disposition: SourceDisposition;
}

export interface OrgExport {
  meta: OrgExportMeta;
  /** The org row. */
  org: Record<string, unknown>;
  /** The org's own records, keyed by section. */
  data: Record<string, unknown[]>;
  /** Credentials the org holds — identity of each, never the material. */
  attributions: Record<string, unknown[]>;
  /** A fork's org-owned records, keyed by section. Present only when a fork registered a source. */
  app?: Record<string, unknown[]>;
}

/** Raised when no org row matches. */
export class OrgNotFoundError extends Error {
  constructor(orgId: string) {
    super(`No org with id ${orgId}`);
    this.name = 'OrgNotFoundError';
  }
}

/**
 * Raised when the fork's `initAppOrgSources()` threw or registered a row the
 * registry rejected, so which of its tables the org owns is unknown or short.
 * Exporting anyway would hand over a bundle without some of the fork's tables
 * and with nothing in it saying so.
 */
export class AppOrgDeclarationsUnavailableError extends Error {
  constructor() {
    super(
      'initAppOrgSources() threw or registered a declaration that was rejected, so this ' +
        'app tier’s org-data declarations are incomplete and the org export cannot be ' +
        'certified complete. Fix the seam in lib/app/org-export.ts — the failure was ' +
        'logged by lib/privacy/org-source-registry.ts.'
    );
    this.name = 'AppOrgDeclarationsUnavailableError';
  }
}

/**
 * Raised when a fork source's `fetch` resolved to something other than an
 * array. Its section would otherwise be missing or malformed in a bundle that
 * reads as complete.
 */
export class AppOrgSourceInvalidError extends Error {
  readonly model: string;

  constructor(model: string, section: string) {
    super(
      `The org source for ${model} (section '${section}') did not resolve to an array. ` +
        'Return [] when the org has no rows. See lib/app/org-export.ts.'
    );
    this.name = 'AppOrgSourceInvalidError';
    this.model = model;
  }
}

/**
 * Build one org's export bundle. Every source runs against the live
 * database; volume is unbounded by design, as with the subject export.
 *
 * @throws {OrgNotFoundError} if no org row matches `orgId`
 * @throws {AppOrgDeclarationsUnavailableError} if the fork's org-source init threw or a declaration was rejected
 * @throws {AppOrgSourceInvalidError} if a fork source's `fetch` did not return an array
 */
export async function exportOrgData(params: ExportOrgParams): Promise<OrgExport> {
  const { orgId, actorUserId } = params;

  const org = await prisma.org.findUnique({ where: { id: orgId } });
  if (!org) {
    throw new OrgNotFoundError(orgId);
  }

  // Before any read: a fork whose declarations are unknown cannot be exported
  // completely, and a half-built bundle must not be the thing that ships.
  if (appOrgDeclarationsFailed()) {
    throw new AppOrgDeclarationsUnavailableError();
  }
  const appSources = getAppOrgSources();

  const query: OrgQuery = { orgId };

  // A rejection propagates: an export that quietly lost a section would be
  // indistinguishable, to the reader, from one that had nothing to show.
  //
  // Read as the org being exported, not as whoever is asking (§106 t-735). At
  // `multi` the admin route runs inside the admin's own active org, and the
  // `org_isolation` policy would AND every `ownedBy(orgId)` below with that
  // org, so any other org's export came back with every section empty; an
  // admin API key enters no org at all, and the reads threw. Entering the
  // target here, rather than in the route, means any caller gets it — §111's
  // planned owner self-service export is meant to sit on this same service.
  //
  // One source at a time, not all at once. At `multi` the data layer runs
  // each read as its own transaction (the org setter, then the query), and
  // each holds a pooled connection for as long as its query runs. Starting
  // all 42 together against a pool of 10 (1 on a serverless deploy) leaves
  // the rest waiting for a connection, where a large org's reads can time out
  // and fail the whole export.
  //
  // A fork's sources run after core's, in the same context and the same way.
  //
  // Every member's personal rows are in an org export by design, so for the
  // owner layer (§115) it is a declared crossing: the route decided who may
  // export the org, and an exporter narrowed to one member would be refused
  // the first member's rows that were not the asker's.
  const { results, appResults } = await runAcrossOwners(
    "org data export: every member's rows, for whoever the route admitted",
    () =>
      runAsOrg(orgId, async () => {
        const fetched: Array<{ source: (typeof ORG_DATA_SOURCES)[number]; rows: unknown[] }> = [];
        for (const source of ORG_DATA_SOURCES) {
          fetched.push({ source, rows: await source.fetch(query) });
        }
        const appFetched: Array<{ source: (typeof appSources)[number]; rows: unknown[] }> = [];
        for (const source of appSources) {
          const rows: unknown = await source.fetch(query);
          if (!Array.isArray(rows))
            throw new AppOrgSourceInvalidError(source.model, source.section);
          appFetched.push({ source, rows });
        }
        return { results: fetched, appResults: appFetched };
      })
  );

  const data: Record<string, unknown[]> = {};
  const attributions: Record<string, unknown[]> = {};
  const exported: ExportedSourceSummary[] = [];
  const attribution: ExportedSourceSummary[] = [];

  for (const { source, rows } of results) {
    const summary: ExportedSourceSummary = {
      model: source.model,
      section: source.section,
      description: source.description,
      rows: rows.length,
    };
    if (source.disposition === 'export') {
      data[source.section] = rows;
      exported.push(summary);
    } else {
      attributions[source.section] = rows;
      attribution.push(summary);
    }
  }

  const app: Record<string, unknown[]> = {};
  const appSummaries: AppOrgSourceSummary[] = [];
  for (const { source, rows } of appResults) {
    app[source.section] = rows;
    appSummaries.push({
      model: source.model,
      section: source.section,
      description: source.description,
      disposition: source.disposition,
      rows: rows.length,
    });
  }

  const everyResult = [...results, ...appResults];
  logger.info('Org data export generated', {
    orgId,
    actorUserId,
    sources: everyResult.length,
    totalRows: everyResult.reduce((sum, { rows }) => sum + rows.length, 0),
  });

  // `app` and `meta.app` only when a fork registered a source, so a vanilla
  // install's bundle keeps exactly the shape it had before the seam existed.
  const hasApp = appSources.length > 0;
  return {
    meta: {
      formatVersion: ORG_EXPORT_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      orgId,
      exported,
      attribution,
      excluded: [...ORG_EXCLUDED_SOURCES, ...getAppExcludedOrgSources()],
      ...(hasApp ? { app: appSummaries } : {}),
    },
    org,
    data,
    attributions,
    ...(hasApp ? { app } : {}),
  };
}
