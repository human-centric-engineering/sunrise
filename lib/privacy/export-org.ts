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
 * @see lib/privacy/org-sources.ts — the manifest and its coverage guard
 * @see lib/privacy/erase-org.ts — the deletion this precedes
 * @see lib/privacy/export-user.ts — the per-person shape this mirrors
 * @see .context/privacy/org-export.md — the guide
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  ORG_DATA_SOURCES,
  ORG_EXCLUDED_SOURCES,
  type OrgExcludedSource,
  type OrgQuery,
} from '@/lib/privacy/org-sources';
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
  /** Tables deliberately left out, with the reason. */
  excluded: OrgExcludedSource[];
}

export interface OrgExport {
  meta: OrgExportMeta;
  /** The org row. */
  org: Record<string, unknown>;
  /** The org's own records, keyed by section. */
  data: Record<string, unknown[]>;
  /** Credentials the org holds — identity of each, never the material. */
  attributions: Record<string, unknown[]>;
}

/** Raised when no org row matches. */
export class OrgNotFoundError extends Error {
  constructor(orgId: string) {
    super(`No org with id ${orgId}`);
    this.name = 'OrgNotFoundError';
  }
}

/**
 * Build one org's export bundle. Every source runs against the live
 * database; volume is unbounded by design, as with the subject export.
 *
 * @throws {OrgNotFoundError} if no org row matches `orgId`
 */
export async function exportOrgData(params: ExportOrgParams): Promise<OrgExport> {
  const { orgId, actorUserId } = params;

  const org = await prisma.org.findUnique({ where: { id: orgId } });
  if (!org) {
    throw new OrgNotFoundError(orgId);
  }

  const query: OrgQuery = { orgId };

  // A rejection propagates: an export that quietly lost a section would be
  // indistinguishable, to the reader, from one that had nothing to show.
  const results = await Promise.all(
    ORG_DATA_SOURCES.map(async (source) => ({ source, rows: await source.fetch(query) }))
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

  logger.info('Org data export generated', {
    orgId,
    actorUserId,
    sources: results.length,
    totalRows: results.reduce((sum, { rows }) => sum + rows.length, 0),
  });

  return {
    meta: {
      formatVersion: ORG_EXPORT_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      orgId,
      exported,
      attribution,
      excluded: [...ORG_EXCLUDED_SOURCES],
    },
    org,
    data,
    attributions,
  };
}
