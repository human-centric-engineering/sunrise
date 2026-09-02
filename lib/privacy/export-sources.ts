/**
 * Subject-data source manifest (GDPR Art. 15).
 *
 * The single place that answers "which tables count as this person's data?".
 * Every Prisma model with an FK to `User` appears here exactly once, with an
 * explicit disposition — there is no implicit "and everything else". A model
 * that is missing fails `tests/unit/lib/privacy/export-sources.test.ts`, which
 * parses `prisma/schema/*.prisma` and diffs it against this file.
 *
 * That guard is the point of the manifest. An export that omits a table looks
 * like a complete answer, which is worse than having no export at all: the
 * subject has no way to tell. So adding a `User` relation without deciding what
 * the subject receives breaks the build, exactly as omitting an `onDelete`
 * breaks erasure (see `.context/privacy/data-erasure.md`).
 *
 * Two dispositions, plus a documented exclusion list:
 *
 *   • `export`      — the subject's own data. Returned in full, minus the
 *                     secrets named in `omit` (see below).
 *   • `attribution` — org config they created. `createdBy` is attribution, not
 *                     ownership (the erasure model keeps these rows and nulls
 *                     the link), so the personal data here is the *fact of
 *                     authorship*, not the config. Returns id + label + date —
 *                     not the agent's prompt or the provider's settings.
 *   • {@link EXCLUDED_SOURCES} — carries a written reason, surfaced in the
 *                     export's own `meta` so the subject sees what was withheld
 *                     and why.
 *
 * **Secrets are named, not the fields to include.** Every `export` fetch uses
 * Prisma's `omit` rather than `select`, so a column added to one of these
 * tables tomorrow is exported by default and only a deliberate `omit` keeps it
 * out. The inverse (an allowlist `select`) silently narrows the export every
 * time someone adds a column — the same quiet-omission failure the coverage
 * guard exists to prevent. What gets omitted is credential material only:
 * session tokens, password hashes, OAuth tokens, API-key hashes, HMAC secrets.
 *
 * @see lib/privacy/export-user.ts — the service that assembles these
 * @see lib/app/data-export.ts — the fork seam for app-owned tables
 * @see .context/privacy/data-export.md — the guide
 */

import { prisma } from '@/lib/db/client';

/** How a `User`-linked model is represented in a subject export. */
export type SourceDisposition = 'export' | 'attribution';

/** Identity of the subject being exported. */
export interface SubjectQuery {
  /** Id of the data subject. */
  userId: string;
  /** The subject's email — needed by sources that have no FK (see `ContactSubmission`). */
  email: string;
}

/** One row of "you created this", with none of the created thing's content. */
export interface AttributionRow {
  id: string;
  /** Human-readable handle — a name, a label, or a version number. May be null. */
  label: string | null;
  createdAt: Date;
}

/** A `User`-linked model and how it is exported. */
export interface SubjectDataSource {
  /** Prisma model name, exactly as written in `prisma/schema/*.prisma`. The coverage guard matches on this. */
  model: string;
  /** Key this source lands under in the export bundle. */
  section: string;
  disposition: SourceDisposition;
  /** One line on why this is the subject's data — surfaced in the export's `meta`. */
  description: string;
  /**
   * Set when this source deliberately returns only SOME of the rows matching the
   * subject, saying which rows it withholds and why. Surfaced in the export's
   * `meta` alongside the row count.
   *
   * A source that narrows without one is the silent-omission failure this whole
   * manifest exists to prevent, just at row granularity instead of table
   * granularity — the count looks like an answer either way.
   */
  scopeNote?: string;
  fetch: (subject: SubjectQuery) => Promise<unknown[]>;
}

/** A model deliberately left out of the export, with the reason the subject is shown. */
export interface ExcludedSource {
  model: string;
  reason: string;
}

/** Narrow `{ id, name, createdAt }` rows to the attribution shape. */
function toAttribution(rows: { id: string; name: string; createdAt: Date }[]): AttributionRow[] {
  return rows.map((row) => ({ id: row.id, label: row.name, createdAt: row.createdAt }));
}

const byCreatedAt = { createdAt: 'asc' } as const;
const namedSelect = { id: true, name: true, createdAt: true } as const;

/**
 * Every `User`-linked model, with its disposition. Ordered personal-data first,
 * then attribution — the order the export bundle presents them in.
 */
export const SUBJECT_DATA_SOURCES: SubjectDataSource[] = [
  // ---------------------------------------------------------------------
  // Personal data — the subject's own records.
  // ---------------------------------------------------------------------
  {
    model: 'Session',
    section: 'sessions',
    disposition: 'export',
    description: 'Sign-in sessions, including the IP address and user agent recorded for each.',
    // `token` is a live credential — exporting it would hand a reader the account.
    fetch: ({ userId }) =>
      prisma.session.findMany({
        where: { userId },
        omit: { token: true },
        orderBy: byCreatedAt,
      }),
  },
  {
    model: 'Account',
    section: 'authProviders',
    disposition: 'export',
    description: 'Linked sign-in methods (email/password, OAuth providers).',
    // Password hash and OAuth tokens are credential material, not a copy of
    // the subject's data — an export is not an authorised place for either.
    fetch: ({ userId }) =>
      prisma.account.findMany({
        where: { userId },
        omit: { password: true, accessToken: true, refreshToken: true, idToken: true },
        orderBy: byCreatedAt,
      }),
  },
  {
    model: 'AiConversation',
    section: 'conversations',
    disposition: 'export',
    description: 'Conversations with agents, including every message and any public share link.',
    // Inbound threads (SMS, WhatsApp, email, Slack) do not match here and need
    // no filter to keep them out: they are written system-owned, `userId =
    // null`, because the messages are a third party's rather than any account
    // holder's (#502). Between #467 and #502 this source carried an explicit
    // `channel: null` filter and a `scopeNote` disclosing the narrowing, to
    // contain a write path that stamped the operator who configured the
    // channel onto those rows. The write path is fixed and the history
    // backfilled, so the filter would now select nothing and the note would
    // announce a narrowing that no longer happens.
    fetch: ({ userId }) =>
      prisma.aiConversation.findMany({
        where: { userId },
        include: { messages: { orderBy: byCreatedAt }, share: true },
        orderBy: byCreatedAt,
      }),
  },
  {
    model: 'AiUserMemory',
    section: 'agentMemory',
    disposition: 'export',
    description: 'Facts agents have remembered about the subject across conversations.',
    fetch: ({ userId }) =>
      prisma.aiUserMemory.findMany({ where: { userId }, orderBy: byCreatedAt }),
  },
  {
    model: 'AiEvaluationSession',
    section: 'evaluationSessions',
    disposition: 'export',
    description: 'Evaluation sessions the subject ran, with their annotations.',
    fetch: ({ userId }) =>
      prisma.aiEvaluationSession.findMany({ where: { userId }, orderBy: byCreatedAt }),
  },
  {
    model: 'AiEvaluationRun',
    section: 'evaluationRuns',
    disposition: 'export',
    description: 'Batch evaluation runs the subject started.',
    fetch: ({ userId }) =>
      prisma.aiEvaluationRun.findMany({ where: { userId }, orderBy: byCreatedAt }),
  },
  {
    model: 'AiApiKey',
    section: 'apiKeys',
    disposition: 'export',
    description:
      'API keys the subject issued, including scopes and last use. The keys themselves are not stored.',
    // Only the SHA-256 hash is stored, but exporting it still leaks material
    // for an offline guess against a known key format.
    fetch: ({ userId }) =>
      prisma.aiApiKey.findMany({
        where: { userId },
        omit: { keyHash: true },
        orderBy: byCreatedAt,
      }),
  },
  {
    model: 'AiWorkflowExecution',
    section: 'workflowExecutions',
    disposition: 'export',
    description: 'Workflow runs the subject triggered, including their inputs and outputs.',
    // As with `AiConversation` above, the `triggerSource: null` filter this
    // carried between #467 and #502 is gone: inbound and scheduled runs are
    // system-owned now, so `userId` no longer selects them. That filter
    // guarded the worse half of the same bug — an inbound run's
    // `inputData.trigger` is the adapter payload written verbatim (sender
    // phone number, email From/Subject/body, base64 attachment bytes) and it
    // sat under a `userId` naming the operator who set the channel up.
    //
    // Pre-#502 rows were backfilled by migration
    // `20260801090000_system_owned_inbound_runs`, with one documented
    // exception: scheduled runs created before it are unidentifiable and keep
    // their author. They still export, and correctly — their `inputData` is
    // that operator's own `inputTemplate`, not anyone else's message.
    fetch: ({ userId }) =>
      prisma.aiWorkflowExecution.findMany({
        where: { userId },
        orderBy: byCreatedAt,
      }),
  },
  {
    model: 'AiWebhookSubscription',
    section: 'notificationSubscriptions',
    disposition: 'export',
    description: 'Event notification subscriptions (webhook or email) the subject set up.',
    // `secret` is the HMAC signing key for outbound deliveries.
    fetch: ({ userId }) =>
      prisma.aiWebhookSubscription.findMany({
        where: { createdBy: userId },
        omit: { secret: true },
        orderBy: byCreatedAt,
      }),
  },
  {
    model: 'AiAdminAuditLog',
    section: 'adminActions',
    disposition: 'export',
    // Retained (`SetNull`) rather than cascaded, but the row carries the
    // subject's own IP address, so it is their personal data while the link
    // exists — erasure scrubs `clientIp` for exactly this reason.
    description: 'Admin configuration changes the subject made, including the IP address recorded.',
    fetch: ({ userId }) =>
      prisma.aiAdminAuditLog.findMany({ where: { userId }, orderBy: byCreatedAt }),
  },
  {
    model: 'ContactSubmission',
    section: 'contactSubmissions',
    disposition: 'export',
    description: 'Messages sent through the public contact form from the subject’s email address.',
    // ⚠️ No FK to `User`, and no user id in any column — the public contact form
    // takes an address, not a session. So this table is invisible to the erasure
    // cascade AND to both of the guard's nets: the relation scan and the
    // user-id-column scan. It is listed here purely by hand, and it is the
    // reason the manifest still needs a human deciding what a new table holds.
    // Any table keyed by email, phone number, or an external identifier needs
    // the same treatment; nothing mechanical will find it for you.
    fetch: ({ email }) =>
      prisma.contactSubmission.findMany({
        where: { email: { equals: email, mode: 'insensitive' } },
        orderBy: byCreatedAt,
      }),
  },
  {
    model: 'AiCostLog',
    section: 'usageCosts',
    disposition: 'export',
    description:
      'AI usage recorded against the subject: the model and provider used, token counts, and the cost of each request they caused. Usage is attributed to an account only from 2026-09-02, when cost logging gained a user link; earlier activity, and activity from paths with no signed-in user (document ingestion, scheduled runs, the embeddable widget), carries no attribution and appears here for nobody.',
    // Was in EXCLUDED_SOURCES until this column existed, on the stated grounds
    // that it "carries no user link". That was true and is not any more, so the
    // exclusion went with it. `export` rather than `attribution`: attribution is
    // for org config the subject authored, where the fact of authorship is
    // theirs and the contents are not. This is the inverse — the rows ARE a
    // record of the subject's own activity, so they get the rows.
    //
    // Rows from before the column existed, and rows from user-less paths
    // (ingestion, scheduled runs, embed traffic), carry NULL and so are
    // correctly absent from any subject's export rather than misattributed.
    fetch: ({ userId }) =>
      prisma.aiCostLog.findMany({
        where: { userId },
        orderBy: byCreatedAt,
      }),
  },

  // ---------------------------------------------------------------------
  // Attribution — org config the subject created. Identity of the thing,
  // never its contents: the config belongs to the organisation, the fact of
  // authorship belongs to the subject.
  // ---------------------------------------------------------------------
  {
    model: 'AiAgent',
    section: 'agents',
    disposition: 'attribution',
    description: 'Agents the subject created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiAgent.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiAgentProfile',
    section: 'agentProfiles',
    disposition: 'attribution',
    description: 'Shared agent profiles the subject created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiAgentProfile.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiAgentVersion',
    section: 'agentVersions',
    disposition: 'attribution',
    description: 'Agent versions the subject published.',
    fetch: async ({ userId }: SubjectQuery): Promise<AttributionRow[]> => {
      const rows = await prisma.aiAgentVersion.findMany({
        where: { createdBy: userId },
        select: { id: true, version: true, createdAt: true },
        orderBy: byCreatedAt,
      });
      return rows.map((row) => ({
        id: row.id,
        label: `v${row.version}`,
        createdAt: row.createdAt,
      }));
    },
  },
  {
    model: 'AiAgentInviteToken',
    section: 'agentInviteTokens',
    disposition: 'attribution',
    description: 'Agent invite links the subject issued. The token values are not included.',
    fetch: async ({ userId }: SubjectQuery): Promise<AttributionRow[]> => {
      const rows = await prisma.aiAgentInviteToken.findMany({
        where: { createdBy: userId },
        select: { id: true, label: true, createdAt: true },
        orderBy: byCreatedAt,
      });
      return rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.createdAt }));
    },
  },
  {
    model: 'AiAgentEmbedToken',
    section: 'agentEmbedTokens',
    disposition: 'attribution',
    description: 'Embed tokens the subject issued. The token values are not included.',
    fetch: async ({ userId }: SubjectQuery): Promise<AttributionRow[]> => {
      const rows = await prisma.aiAgentEmbedToken.findMany({
        where: { createdBy: userId },
        select: { id: true, label: true, createdAt: true },
        orderBy: byCreatedAt,
      });
      return rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.createdAt }));
    },
  },
  {
    model: 'AiWorkflow',
    section: 'workflows',
    disposition: 'attribution',
    description: 'Workflows the subject created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiWorkflow.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiWorkflowVersion',
    section: 'workflowVersions',
    disposition: 'attribution',
    description: 'Workflow versions the subject published.',
    fetch: async ({ userId }: SubjectQuery): Promise<AttributionRow[]> => {
      const rows = await prisma.aiWorkflowVersion.findMany({
        where: { createdBy: userId },
        select: { id: true, version: true, createdAt: true },
        orderBy: byCreatedAt,
      });
      return rows.map((row) => ({
        id: row.id,
        label: `v${row.version}`,
        createdAt: row.createdAt,
      }));
    },
  },
  {
    model: 'AiWorkflowSchedule',
    section: 'workflowSchedules',
    disposition: 'attribution',
    description: 'Workflow schedules the subject created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiWorkflowSchedule.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiWorkflowTrigger',
    section: 'workflowTriggers',
    disposition: 'attribution',
    description: 'Workflow triggers the subject created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiWorkflowTrigger.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiEventHook',
    section: 'eventHooks',
    disposition: 'attribution',
    description: 'Event hooks the subject created. Signing secrets are not included.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiEventHook.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiKnowledgeDocument',
    section: 'knowledgeDocuments',
    disposition: 'attribution',
    description:
      'Knowledge-base documents the subject uploaded. Document contents are not included.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiKnowledgeDocument.findMany({
          where: { uploadedBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiDataset',
    section: 'datasets',
    disposition: 'attribution',
    description: 'Evaluation datasets the subject created. Test cases are not included.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiDataset.findMany({
          where: { userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiProviderConfig',
    section: 'providerConfigs',
    disposition: 'attribution',
    description: 'LLM provider configurations the subject created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiProviderConfig.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiProviderModel',
    section: 'providerModels',
    disposition: 'attribution',
    description: 'Provider models the subject registered.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiProviderModel.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'AiExperiment',
    section: 'experiments',
    disposition: 'attribution',
    description: 'A/B experiments the subject created.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.aiExperiment.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'McpApiKey',
    section: 'mcpApiKeys',
    disposition: 'attribution',
    description: 'MCP server API keys the subject issued. Key hashes are not included.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.mcpApiKey.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'FeatureFlag',
    section: 'featureFlags',
    disposition: 'attribution',
    description: 'Feature flags the subject created.',
    // ⚠️ Second table with no `@relation` to `User` (see `ContactSubmission`
    // above). `createdBy` is a plain `String?` holding a user id, written by
    // `POST /api/v1/admin/feature-flags`, so the FK-based coverage scan cannot
    // see it. Listed by hand, and pinned by a test row.
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.featureFlag.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
  {
    model: 'McpExposedPrompt',
    section: 'mcpPrompts',
    disposition: 'attribution',
    description: 'MCP prompts the subject exposed.',
    fetch: async ({ userId }) =>
      toAttribution(
        await prisma.mcpExposedPrompt.findMany({
          where: { createdBy: userId },
          select: namedSelect,
          orderBy: byCreatedAt,
        })
      ),
  },
];

/**
 * Models deliberately left out, and why. Surfaced in the export's `meta` so a
 * subject can see the boundary of what they received rather than having to
 * infer it. These have no `User` FK, so the coverage guard does not require
 * them — they are listed because a reader would reasonably wonder.
 */
export const EXCLUDED_SOURCES: ExcludedSource[] = [
  {
    model: 'AiMessageEmbedding',
    reason:
      'Numeric vectors derived from message text that is already included in full under `conversations`. They carry no information the messages do not.',
  },
  {
    model: 'Verification',
    reason:
      'Short-lived email verification and password-reset tokens. Live credential material, deleted on use or expiry, and never retained as a record.',
  },
];

/** Sources returned in full. */
export function exportedSources(): SubjectDataSource[] {
  return SUBJECT_DATA_SOURCES.filter((source) => source.disposition === 'export');
}

/** Sources returned as id + label + date only. */
export function attributionSources(): SubjectDataSource[] {
  return SUBJECT_DATA_SOURCES.filter((source) => source.disposition === 'attribution');
}
