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
 * against this file. §107 t-705 added `orgId` to every tenant-owned model and that test named
 * all 38 until each had a disposition below — which is the point.
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
import { toSafeHook, type SafeHook } from '@/lib/orchestration/hooks/serialize';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant } from '@/lib/tenancy/context';

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

/**
 * The `where` for a tenant-owned model, read the way the tenant context reads
 * a missing org: at `TENANCY_MODE=single` a row with `orgId IS NULL` belongs
 * to the install org — nothing writes the column until the data-layer
 * chokepoint (§107 3.2) lands, so every row created between the backfill
 * migration and that PR carries `NULL`, and the install org's export would
 * otherwise silently omit it (a fresh install would export none of its
 * seeded agents; caught by the t-705 code review). At `multi` the match is
 * strict: `db:tenancy:enable` backfills `NULL` before enforcing, so a `NULL`
 * there is an orphan, not the install org's. The credential attributions
 * below deliberately do NOT use this — a `NULL`-org API key is a platform
 * credential, not the org's.
 */
function ownedBy(orgId: string): { orgId: string } | { OR: [{ orgId: string }, { orgId: null }] } {
  if (orgId === INSTALL_ORG_ID && !isMultiTenant()) return { OR: [{ orgId }, { orgId: null }] };
  return { orgId };
}

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
  // Tenant-owned records (§107 t-705) — every model that carries `orgId`
  // because a row of it belongs to one org. Full rows minus the named secrets
  // (two signing secrets, a lease token, and a hook's header values via
  // `toSafeHook`); vector columns are `Unsupported` and never selected.
  // ---------------------------------------------------------------------
  {
    model: 'AiAgent',
    section: 'agents',
    disposition: 'export',
    description:
      'The organisation’s agents: name, slug, instructions, model and provider choices, visibility and runtime settings.',
    fetch: ({ orgId }) =>
      prisma.aiAgent.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiAgentVersion',
    section: 'agentVersions',
    disposition: 'export',
    description:
      'Every published version of each agent — the configuration snapshot as it was at publish time.',
    fetch: ({ orgId }) =>
      prisma.aiAgentVersion.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiAgentCapability',
    section: 'agentCapabilities',
    disposition: 'export',
    description:
      'Which platform capabilities each agent is bound to, and the per-agent configuration of that binding. The capability definitions themselves are platform config and are not included.',
    fetch: ({ orgId }) =>
      prisma.aiAgentCapability.findMany({
        where: ownedBy(orgId),
        orderBy: [{ agentId: 'asc' }, { capabilityId: 'asc' }],
      }),
  },
  {
    model: 'AiAgentKnowledgeDocument',
    section: 'agentKnowledgeDocuments',
    disposition: 'export',
    description: 'Which knowledge documents each agent can search.',
    fetch: ({ orgId }) =>
      prisma.aiAgentKnowledgeDocument.findMany({
        where: ownedBy(orgId),
        orderBy: [{ agentId: 'asc' }, { documentId: 'asc' }],
      }),
  },
  {
    model: 'AiAgentKnowledgeTag',
    section: 'agentKnowledgeTags',
    disposition: 'export',
    description:
      'Which knowledge tags each agent searches by. The tag definitions are platform config and are not included.',
    fetch: ({ orgId }) =>
      prisma.aiAgentKnowledgeTag.findMany({
        where: ownedBy(orgId),
        orderBy: [{ agentId: 'asc' }, { tagId: 'asc' }],
      }),
  },
  {
    model: 'AiConversation',
    section: 'conversations',
    disposition: 'export',
    description:
      'Every conversation held with the organisation’s agents: title, channel, participant, context and timestamps.',
    fetch: ({ orgId }) =>
      prisma.aiConversation.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiMessage',
    section: 'messages',
    disposition: 'export',
    description:
      'Every message in those conversations — role, content, tool calls and token counts.',
    fetch: ({ orgId }) =>
      prisma.aiMessage.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiConversationShare',
    section: 'conversationShares',
    disposition: 'export',
    description: 'Share grants on conversations: reason, expiry and revocation.',
    fetch: ({ orgId }) =>
      prisma.aiConversationShare.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiOutboundMessage',
    section: 'outboundMessages',
    disposition: 'export',
    description:
      'Messages the organisation’s agents sent out over external channels, with delivery status.',
    fetch: ({ orgId }) =>
      prisma.aiOutboundMessage.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiCostLog',
    section: 'costLog',
    disposition: 'export',
    description: 'Per-call model usage and cost for the organisation’s agents and workflows.',
    fetch: ({ orgId }) =>
      prisma.aiCostLog.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiUserMemory',
    section: 'userMemories',
    disposition: 'export',
    description:
      'Facts the organisation’s agents remembered about their users between conversations.',
    fetch: ({ orgId }) =>
      prisma.aiUserMemory.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiEventHook',
    section: 'eventHooks',
    disposition: 'export',
    description:
      'Event hooks the organisation configured — the event, the filter and the action. The hook’s signing secret and the values of its custom request headers are not included.',
    // `action.headers` holds whatever the author put there — in practice the
    // receiver's `Authorization` — so the rows go through the same redaction
    // the admin API applies (`toSafeHook`): header names stay, values are
    // masked, `secret` is dropped. Found by the security review of t-705.
    fetch: async ({ orgId }: OrgQuery): Promise<SafeHook[]> => {
      const rows = await prisma.aiEventHook.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toSafeHook);
    },
  },
  {
    model: 'AiEventHookDelivery',
    section: 'eventHookDeliveries',
    disposition: 'export',
    description: 'Each attempt to deliver an event to a hook, with the payload and the outcome.',
    fetch: ({ orgId }) =>
      prisma.aiEventHookDelivery.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiWebhookSubscription',
    section: 'webhookSubscriptions',
    disposition: 'export',
    description:
      'Outbound webhook subscriptions — channel, destination, events and retry policy. The signing secret is not included.',
    fetch: ({ orgId }) =>
      prisma.aiWebhookSubscription.findMany({
        where: ownedBy(orgId),
        omit: { secret: true },
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiWebhookDelivery',
    section: 'webhookDeliveries',
    disposition: 'export',
    description:
      'Each attempt to deliver an event to a webhook subscription, with the payload and the outcome.',
    fetch: ({ orgId }) =>
      prisma.aiWebhookDelivery.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiExperiment',
    section: 'experiments',
    disposition: 'export',
    description: 'A/B experiments the organisation ran on its agents.',
    fetch: ({ orgId }) =>
      prisma.aiExperiment.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiExperimentVariant',
    section: 'experimentVariants',
    disposition: 'export',
    description: 'The variants of each experiment and their results.',
    fetch: ({ orgId }) =>
      prisma.aiExperimentVariant.findMany({
        where: ownedBy(orgId),
        orderBy: { id: 'asc' },
      }),
  },
  {
    model: 'AiDataset',
    section: 'datasets',
    disposition: 'export',
    description: 'Evaluation datasets the organisation authored.',
    fetch: ({ orgId }) =>
      prisma.aiDataset.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiDatasetCase',
    section: 'datasetCases',
    disposition: 'export',
    description: 'The cases in each dataset — inputs and expected outputs.',
    fetch: ({ orgId }) =>
      prisma.aiDatasetCase.findMany({
        where: ownedBy(orgId),
        orderBy: { id: 'asc' },
      }),
  },
  {
    model: 'AiEvaluationSession',
    section: 'evaluationSessions',
    disposition: 'export',
    description: 'Manual evaluation sessions on the organisation’s agents.',
    fetch: ({ orgId }) =>
      prisma.aiEvaluationSession.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiEvaluationLog',
    section: 'evaluationLogs',
    disposition: 'export',
    description: 'Per-message annotations and scores recorded in evaluation sessions.',
    fetch: ({ orgId }) =>
      prisma.aiEvaluationLog.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiEvaluationRun',
    section: 'evaluationRuns',
    disposition: 'export',
    description: 'Dataset-driven evaluation runs, their configuration and summary.',
    fetch: ({ orgId }) =>
      prisma.aiEvaluationRun.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiEvaluationCaseResult',
    section: 'evaluationCaseResults',
    disposition: 'export',
    description: 'The per-case outcome of each evaluation run.',
    fetch: ({ orgId }) =>
      prisma.aiEvaluationCaseResult.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiKnowledgeBase',
    section: 'knowledgeBases',
    disposition: 'export',
    description: 'The organisation’s knowledge bases.',
    fetch: ({ orgId }) =>
      prisma.aiKnowledgeBase.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiKnowledgeDocument',
    section: 'knowledgeDocuments',
    disposition: 'export',
    description:
      'Every document in those knowledge bases — name, slug, source, status and the document text.',
    fetch: ({ orgId }) =>
      prisma.aiKnowledgeDocument.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiKnowledgeDocumentRevision',
    section: 'knowledgeDocumentRevisions',
    disposition: 'export',
    description: 'The revision history of each document.',
    fetch: ({ orgId }) =>
      prisma.aiKnowledgeDocumentRevision.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiKnowledgeDocumentPendingChange',
    section: 'knowledgeDocumentPendingChanges',
    disposition: 'export',
    description: 'Edits to documents that are proposed but not yet applied.',
    fetch: ({ orgId }) =>
      prisma.aiKnowledgeDocumentPendingChange.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiKnowledgeChunk',
    section: 'knowledgeChunks',
    disposition: 'export',
    description:
      'The searchable chunks each document was split into, with their text and metadata. The vector embeddings are derived data and are not included.',
    fetch: ({ orgId }) =>
      prisma.aiKnowledgeChunk.findMany({
        where: ownedBy(orgId),
        orderBy: { id: 'asc' },
      }),
  },
  {
    model: 'AiKnowledgeDocumentTag',
    section: 'knowledgeDocumentTags',
    disposition: 'export',
    description:
      'Which tags each document carries. The tag definitions are platform config and are not included.',
    fetch: ({ orgId }) =>
      prisma.aiKnowledgeDocumentTag.findMany({
        where: ownedBy(orgId),
        orderBy: [{ documentId: 'asc' }, { tagId: 'asc' }],
      }),
  },
  {
    model: 'AiWorkflow',
    section: 'workflows',
    disposition: 'export',
    description: 'The organisation’s workflows — name, slug, definition and settings.',
    fetch: ({ orgId }) =>
      prisma.aiWorkflow.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiWorkflowVersion',
    section: 'workflowVersions',
    disposition: 'export',
    description: 'Every published version of each workflow.',
    fetch: ({ orgId }) =>
      prisma.aiWorkflowVersion.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiWorkflowSchedule',
    section: 'workflowSchedules',
    disposition: 'export',
    description: 'Cron schedules that run the organisation’s workflows.',
    fetch: ({ orgId }) =>
      prisma.aiWorkflowSchedule.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiWorkflowTrigger',
    section: 'workflowTriggers',
    disposition: 'export',
    description:
      'Inbound triggers on the organisation’s workflows — channel, name and scope. The trigger’s signing secret is not included.',
    fetch: ({ orgId }) =>
      prisma.aiWorkflowTrigger.findMany({
        where: ownedBy(orgId),
        omit: { signingSecret: true },
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiWorkflowExecution',
    section: 'workflowExecutions',
    disposition: 'export',
    description:
      'Every run of the organisation’s workflows — input, output, status, cost and timing. The engine’s lease token is not included.',
    fetch: ({ orgId }) =>
      prisma.aiWorkflowExecution.findMany({
        where: ownedBy(orgId),
        omit: { leaseToken: true },
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiWorkflowStepDispatch',
    section: 'workflowStepDispatches',
    disposition: 'export',
    description: 'The result each workflow step produced on each run.',
    fetch: ({ orgId }) =>
      prisma.aiWorkflowStepDispatch.findMany({
        where: ownedBy(orgId),
        orderBy: { createdAt: 'asc' },
      }),
  },
  {
    model: 'AiWorkflowRunningStep',
    section: 'workflowRunningSteps',
    disposition: 'export',
    description: 'Per-step timing and turn records for each run.',
    fetch: ({ orgId }) =>
      prisma.aiWorkflowRunningStep.findMany({
        where: ownedBy(orgId),
        orderBy: { startedAt: 'asc' },
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
export const ORG_EXCLUDED_SOURCES: OrgExcludedSource[] = [
  {
    model: 'AiMessageEmbedding',
    reason:
      'Vector embeddings derived from messages the export already carries in full; the vector column is Unsupported in Prisma and holds nothing readable.',
  },
  {
    model: 'AiWorkflowExecutionLeaseEvent',
    reason:
      'Engine lease bookkeeping for stuck-execution recovery — lease tokens and heartbeat events, nothing the organisation authored; the executions themselves are exported.',
  },
];
