/**
 * Orchestration Config Exporter
 *
 * Exports agents, capabilities, workflows, webhook subscriptions, and
 * settings as a versioned JSON payload. Excludes secrets, embeddings,
 * and user-specific data.
 *
 * **Scoped to one org** (§109 t-738). The org's own part — agents, workflows,
 * webhook subscriptions — is read inside `runAsOrg(scope.orgId)`, so at
 * `multi` the `org_isolation` policy returns that org's rows whoever asks. The
 * shared part — capabilities, knowledge tags, the `global` settings — is read
 * only when `scope.includeShared`; otherwise the bundle carries it empty
 * (`[]`, `[]`, `null`), which every importer reads as "nothing to write".
 * `resolveBackupScope()` decides both; this function trusts what it is given.
 */

import { prisma } from '@/lib/db/client';
import { runAsOrg } from '@/lib/tenancy/context';
import type { BackupPayload } from '@/lib/orchestration/backup/schema';
import { bundleContacts, sealExport } from '@/lib/orchestration/backup/export-seal';
import type { BackupScope } from '@/lib/orchestration/backup/scope';
import { IMPORTED_FROM_SLUG_KEY } from '@/lib/orchestration/backup/schema';
import { z } from 'zod';
import { REASONING_EFFORTS } from '@/lib/orchestration/llm/types';
import {
  narrowProviderTools,
  narrowServiceTier,
  narrowVerbosity,
} from '@/lib/orchestration/llm/model-params';
import {
  BUILTIN_TEMPLATE_SLUGS,
  SYSTEM_WORKFLOW_SLUGS,
} from '@/lib/orchestration/workflows/template-catalogue';

/**
 * Workflow metadata without the importer's renamed-copy marker: it names a
 * slug held by another org on THIS install, and carried into a bundle it could
 * redirect a later import somewhere the marker means nothing.
 */
function withoutImportMarker(metadata: unknown): unknown {
  const parsed = z.record(z.string(), z.unknown()).safeParse(metadata);
  if (!parsed.success || !(IMPORTED_FROM_SLUG_KEY in parsed.data)) return metadata;
  const { [IMPORTED_FROM_SLUG_KEY]: _marker, ...rest } = parsed.data;
  return rest;
}

export function exportOrchestrationConfig(scope: BackupScope): Promise<BackupPayload> {
  return runAsOrg(scope.orgId, () => readConfig(scope.includeShared, scope.orgId));
}

async function readConfig(includeShared: boolean, orgId: string): Promise<BackupPayload> {
  // Stamped before the reads start, so the copy is no older than the date the
  // importer trusts (§122 t-902): the reads share no snapshot, and one that
  // ran before an erasure committed may still name the person.
  const exportedAt = new Date().toISOString();
  /** The shared-part query when it is included, else its empty value without a read. */
  const sharedOr = <T>(empty: T, read: () => Promise<T>): Promise<T> =>
    includeShared ? read() : Promise.resolve(empty);

  const [agents, capabilities, workflows, webhooks, knowledgeTags, settings] = await Promise.all([
    prisma.aiAgent.findMany({
      where: { isSystem: false },
      select: {
        name: true,
        slug: true,
        description: true,
        systemInstructions: true,
        model: true,
        provider: true,
        fallbackProviders: true,
        temperature: true,
        maxTokens: true,
        monthlyBudgetUsd: true,
        maxCostPerTurnUsd: true,
        visibility: true,
        isActive: true,
        metadata: true,
        knowledgeAccessMode: true,
        knowledgeRetrievalMode: true,
        knowledgeTriggerKeywords: true,
        topicBoundaries: true,
        brandVoiceInstructions: true,
        rateLimitRpm: true,
        inputGuardMode: true,
        outputGuardMode: true,
        citationGuardMode: true,
        maxHistoryTokens: true,
        maxHistoryMessages: true,
        retentionDays: true,
        providerConfig: true,
        widgetConfig: true,
        // Discriminator + profile-inheritance + attachment + runtime-prompt
        // fields. Previously absent from this select, so a config backup
        // silently dropped them on round-trip (a judge agent restored as chat,
        // persona/guardrails/toggles lost). Restored here for full fidelity.
        kind: true,
        reasoningEffort: true,
        stopSequences: true,
        topP: true,
        verbosity: true,
        parallelToolCalls: true,
        serviceTier: true,
        providerTools: true,
        persona: true,
        guardrails: true,
        personaMode: true,
        voiceMode: true,
        guardrailsMode: true,
        enableVoiceInput: true,
        enableImageInput: true,
        enableDocumentInput: true,
        runtimePromptManaged: true,
        runtimePromptNote: true,
        grantedTags: { select: { tag: { select: { slug: true } } } },
        grantedDocuments: { select: { document: { select: { slug: true } } } },
      },
    }),
    sharedOr([], () =>
      prisma.aiCapability.findMany({
        where: { isSystem: false },
        select: {
          name: true,
          slug: true,
          description: true,
          category: true,
          functionDefinition: true,
          executionType: true,
          executionHandler: true,
          executionConfig: true,
          requiresApproval: true,
          rateLimit: true,
          isActive: true,
        },
      })
    ),
    // The built-in templates are served from code, not backed up (§116
    // t-727): a TEMPLATE row holding a built-in slug is a seed-era copy of
    // one. A row with that slug that is an ordinary workflow (a retired row
    // an install switched back on, or one an admin converted) is theirs, and
    // is backed up like any other. A system workflow (the provider-model
    // audit) is the seed's, as system agents and capabilities are, and is
    // left out by its flag AND by its reserved slug: the importer refuses
    // that slug whatever the row type, so a row holding it could never be
    // restored, and a bundle must not carry what it cannot restore.
    prisma.aiWorkflow.findMany({
      where: {
        isSystem: false,
        slug: { notIn: [...SYSTEM_WORKFLOW_SLUGS] },
        NOT: { isTemplate: true, slug: { in: [...BUILTIN_TEMPLATE_SLUGS] } },
      },
      select: {
        name: true,
        slug: true,
        description: true,
        publishedVersion: { select: { snapshot: true } },
        patternsUsed: true,
        isActive: true,
        isTemplate: true,
        metadata: true,
      },
    }),
    prisma.aiWebhookSubscription.findMany({
      select: {
        channel: true,
        url: true,
        emailAddress: true,
        events: true,
        description: true,
        // Exclude secret — never export secrets
        isActive: true,
      },
    }),
    sharedOr([], () =>
      prisma.knowledgeTag.findMany({
        select: {
          slug: true,
          name: true,
          description: true,
        },
      })
    ),
    sharedOr(null, () =>
      prisma.aiOrchestrationSettings.findUnique({
        where: { slug: 'global' },
        select: {
          defaultModels: true,
          globalMonthlyBudgetUsd: true,
          searchConfig: true,
          defaultApprovalTimeoutMs: true,
          approvalDefaultAction: true,
          inputGuardMode: true,
          outputGuardMode: true,
          citationGuardMode: true,
          webhookRetentionDays: true,
          webhookDlqRetentionDays: true,
          costLogRetentionDays: true,
          auditLogRetentionDays: true,
          executionRetentionDays: true,
          evaluationRetentionDays: true,
          maxConversationsPerUser: true,
          maxMessagesPerConversation: true,
          escalationConfig: true,
        },
      })
    ),
  ]);

  // Flatten the published version snapshot back to the wire shape that the
  // importer expects: a single `workflowDefinition` per workflow. The version
  // chain itself isn't carried in backups — backups are config snapshots, not
  // point-in-time history. The importer reseeds v1 from this snapshot.
  // Workflows that have never been published are skipped (they have no
  // exportable definition).
  const flattenedWorkflows = workflows.flatMap((w) =>
    w.publishedVersion
      ? [
          {
            name: w.name,
            slug: w.slug,
            description: w.description,
            workflowDefinition: w.publishedVersion.snapshot,
            patternsUsed: w.patternsUsed,
            isActive: w.isActive,
            isTemplate: w.isTemplate,
            metadata: withoutImportMarker(w.metadata),
          },
        ]
      : []
  );

  // Flatten agent grants into the slug/hash arrays the backup format expects.
  // `grantedTags`/`grantedDocuments` are include-shaped (join rows with one
  // nested entity each) — flatten them before serialising. The narrowing tables
  // and helper are loop-invariant, so they live outside the per-agent map.
  const retrievalModes = ['model', 'first_turn', 'every_turn', 'keywords'] as const;
  const reasoningEfforts = REASONING_EFFORTS;
  const narrowMode = (m: string) => (m === 'append' ? ('append' as const) : ('override' as const));
  const flattenedAgents = agents.map((a) => {
    const {
      grantedTags,
      grantedDocuments,
      knowledgeAccessMode,
      knowledgeRetrievalMode,
      kind,
      personaMode,
      voiceMode,
      guardrailsMode,
      reasoningEffort,
      verbosity,
      serviceTier,
      providerTools,
      ...rest
    } = a;
    return {
      ...rest,
      // The DB columns are `String`; coerce to the strict enums the backup schema wants.
      knowledgeAccessMode:
        knowledgeAccessMode === 'restricted' ? ('restricted' as const) : ('full' as const),
      knowledgeRetrievalMode: (retrievalModes as readonly string[]).includes(knowledgeRetrievalMode)
        ? (knowledgeRetrievalMode as (typeof retrievalModes)[number])
        : ('model' as const),
      kind: kind === 'judge' ? ('judge' as const) : ('chat' as const),
      personaMode: narrowMode(personaMode),
      voiceMode: narrowMode(voiceMode),
      guardrailsMode: narrowMode(guardrailsMode),
      reasoningEffort: (reasoningEfforts as readonly string[]).includes(reasoningEffort ?? '')
        ? (reasoningEffort as (typeof reasoningEfforts)[number])
        : null,
      verbosity: narrowVerbosity(verbosity) ?? null,
      serviceTier: narrowServiceTier(serviceTier) ?? null,
      providerTools: narrowProviderTools(providerTools) ?? null,
      // `knowledgeCategories` was dropped from the DB in Phase 6 but the
      // backup schema keeps the field on the wire for older importers
      // that still read it. Always emit empty.
      knowledgeCategories: [] as string[],
      grantedTagSlugs: grantedTags.map((g) => g.tag.slug),
      // v3: document grants by stable slug (#338). v2's grantedDocumentHashes is
      // no longer emitted — the importer still reads it from older bundles.
      grantedDocumentSlugs: grantedDocuments.map((g) => g.document.slug),
    };
  });

  // Narrow Prisma's `channel: string` to the literal union the backup
  // schema expects. Rows with an unrecognised channel are coerced to
  // `webhook` (matches the schema default) so a corrupted DB row can't
  // make an export reject downstream.
  const exportedWebhooks = webhooks.map((w) => ({
    ...w,
    channel: w.channel === 'email' ? ('email' as const) : ('webhook' as const),
  }));

  return {
    schemaVersion: 3 as const,
    exportedAt,
    exportSeal: sealExport({
      exportedAt,
      orgId,
      contacts: bundleContacts({
        webhooks: exportedWebhooks,
        settings,
        workflows: flattenedWorkflows,
      }),
    }),
    data: {
      agents: flattenedAgents,
      capabilities,
      workflows: flattenedWorkflows,
      webhooks: exportedWebhooks,
      knowledgeTags,
      settings,
    },
  };
}
