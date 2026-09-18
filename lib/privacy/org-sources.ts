/**
 * Org-data source manifest (§106 t-672) — the org-subject counterpart of
 * `SUBJECT_DATA_SOURCES`.
 *
 * The single place that answers "which tables count as this org's data?", for
 * a customer being offboarded who asks for their data before they are
 * deleted. Same discipline as the subject manifest, and for the same reason:
 * an export that omits a table looks like a complete answer, so **every
 * model carrying an `orgId` column appears here exactly once** — as a source
 * with a disposition, or in {@link ORG_EXCLUDED_SOURCES} with a reason. A
 * model that is in neither fails `tests/unit/lib/privacy/org-sources.test.ts`,
 * which parses `prisma/schema/*.prisma` for `orgId` columns and diffs them
 * against this file. Today that is five models; when row isolation (§107)
 * adds `orgId` to the tenant-owned models, that test names every one until
 * someone decides what the org receives from it — which is the point.
 *
 * Dispositions are the subject manifest's two, read for an org:
 *
 *   • `export`      — the org's own records, in full minus named secrets.
 *   • `attribution` — the fact that the org holds a thing, not the thing:
 *                     id + label + date. The four credential kinds are this —
 *                     a key's hash is credential material the export must
 *                     not carry, and its scopes are platform config.
 *
 * **Secrets are named, not the fields to include** (`omit`, never `select`,
 * on an `export` source) — the subject manifest's rule, kept here so a column
 * added tomorrow is exported by default.
 *
 * One source is listed by hand, the `ContactSubmission` precedent: a pending
 * invitation *into* the org lives in `Verification`, keyed by the invitee's
 * email with the org in the metadata JSON, so no column scan can find it.
 *
 * Not a fork seam yet: a fork's own org-owned tables are §109's tenant-data
 * dimension, which this shape is designed to take without a redesign — the
 * subject manifest grew `registerAppSubjectSources()` the same way.
 *
 * @see lib/privacy/export-org.ts — the service that assembles these
 * @see lib/privacy/export-sources.ts — the subject manifest this mirrors
 * @see .context/privacy/org-export.md — the guide
 */

import { prisma } from '@/lib/db/client';
import type { SourceDisposition, AttributionRow } from '@/lib/privacy/export-sources';
import { INVITATION_IDENTIFIER_PREFIX } from '@/lib/utils/invitation-token';

/** Identity of the org being exported. */
export interface OrgQuery {
  orgId: string;
}

/** An `orgId`-carrying model and how it is exported for the org. */
export interface OrgDataSource {
  /** Prisma model name, exactly as written in `prisma/schema/*.prisma`. The coverage guard matches on this. */
  model: string;
  /** Key this source lands under in the export bundle. */
  section: string;
  disposition: SourceDisposition;
  /** One line on why this is the org's data — surfaced in the export's `meta`. */
  description: string;
  fetch: (org: OrgQuery) => Promise<unknown[]>;
}

/** A model deliberately left out of the org export, with the reason shown in `meta`. */
export interface OrgExcludedSource {
  model: string;
  reason: string;
}

const byCreatedAt = { createdAt: 'asc' } as const;

/** Narrow labelled credential rows to the attribution shape. */
function toAttribution(
  rows: { id: string; label: string | null; createdAt: Date }[]
): AttributionRow[] {
  return rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.createdAt }));
}

/**
 * Every `orgId`-carrying model, with its disposition, plus the hand-listed
 * invitation source. Ordered the org's own records first, then attribution —
 * the order the bundle presents them in.
 */
export const ORG_DATA_SOURCES: OrgDataSource[] = [
  // ---------------------------------------------------------------------
  // The org's own records.
  // ---------------------------------------------------------------------
  {
    model: 'OrgMembership',
    section: 'members',
    disposition: 'export',
    description:
      'Who belongs to the organisation and with what role. Each member’s id, name and email ride along so the roster reads as people rather than ids; the members’ other data is theirs, not the org’s, and is not included.',
    fetch: ({ orgId }) =>
      prisma.orgMembership.findMany({
        where: { orgId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: byCreatedAt,
      }),
  },
  {
    model: 'Verification',
    section: 'pendingInvitations',
    disposition: 'export',
    description:
      'Invitations into the organisation that have not been accepted: who was invited, as what, by whom and when. The invitation tokens are not included.',
    // ⚠️ No `orgId` column — the org is in the metadata JSON the invite route
    // writes (`invitationMetadataSchema`), keyed by the invitee's email. The
    // coverage guard cannot see this table, so it is listed by hand, and a
    // test row pins it. The token (`value`) is live credential material.
    fetch: ({ orgId }) =>
      prisma.verification.findMany({
        where: {
          identifier: { startsWith: INVITATION_IDENTIFIER_PREFIX },
          metadata: { path: ['orgId'], equals: orgId },
        },
        omit: { value: true },
        orderBy: byCreatedAt,
      }),
  },

  // ---------------------------------------------------------------------
  // Attribution — credentials minted inside the org. Identity, never the
  // material: a hash is still material for an offline guess, and scopes are
  // platform configuration.
  // ---------------------------------------------------------------------
  {
    model: 'AiApiKey',
    section: 'apiKeys',
    disposition: 'attribution',
    description: 'API keys minted in the organisation. Key hashes and scopes are not included.',
    fetch: async ({ orgId }: OrgQuery): Promise<AttributionRow[]> => {
      const rows = await prisma.aiApiKey.findMany({
        where: { orgId },
        select: { id: true, name: true, createdAt: true },
        orderBy: byCreatedAt,
      });
      return rows.map((row) => ({ id: row.id, label: row.name, createdAt: row.createdAt }));
    },
  },
  {
    model: 'AiAgentEmbedToken',
    section: 'agentEmbedTokens',
    disposition: 'attribution',
    description: 'Embed tokens minted in the organisation. The token values are not included.',
    fetch: async ({ orgId }) =>
      toAttribution(
        await prisma.aiAgentEmbedToken.findMany({
          where: { orgId },
          select: { id: true, label: true, createdAt: true },
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiAgentInviteToken',
    section: 'agentInviteTokens',
    disposition: 'attribution',
    description:
      'Agent invite links minted in the organisation. The token values are not included.',
    fetch: async ({ orgId }) =>
      toAttribution(
        await prisma.aiAgentInviteToken.findMany({
          where: { orgId },
          select: { id: true, label: true, createdAt: true },
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'McpApiKey',
    section: 'mcpApiKeys',
    disposition: 'attribution',
    description: 'MCP server API keys minted in the organisation. Key hashes are not included.',
    fetch: async ({ orgId }: OrgQuery): Promise<AttributionRow[]> => {
      const rows = await prisma.mcpApiKey.findMany({
        where: { orgId },
        select: { id: true, name: true, createdAt: true },
        orderBy: byCreatedAt,
      });
      return rows.map((row) => ({ id: row.id, label: row.name, createdAt: row.createdAt }));
    },
  },
];

/**
 * Models deliberately left out, and why — surfaced in the export's `meta`.
 * Empty today: every `orgId` column is a source. This list exists so that the
 * coverage guard has an honest second answer when §107 adds `orgId` to a
 * model whose rows are not the org's to receive (a platform audit row that
 * happens to record the org, say), rather than forcing a fetch nobody wants.
 */
export const ORG_EXCLUDED_SOURCES: OrgExcludedSource[] = [];
