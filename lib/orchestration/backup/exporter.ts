/**
 * Orchestration Config Exporter
 *
 * Exports agents, capabilities, workflows, webhook subscriptions, and
 * settings as a versioned JSON payload. Excludes secrets, embeddings,
 * and user-specific data.
 */

import { prisma } from '@/lib/db/client';
import type { BackupPayload } from '@/lib/orchestration/backup/schema';

export async function exportOrchestrationConfig(): Promise<BackupPayload> {
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
        visibility: true,
        isActive: true,
        metadata: true,
        knowledgeAccessMode: true,
        topicBoundaries: true,
        brandVoiceInstructions: true,
        rateLimitRpm: true,
        inputGuardMode: true,
        outputGuardMode: true,
        citationGuardMode: true,
        maxHistoryTokens: true,
        retentionDays: true,
        providerConfig: true,
        widgetConfig: true,
        grantedTags: { select: { tag: { select: { slug: true } } } },
        grantedDocuments: { select: { document: { select: { fileHash: true } } } },
      },
    }),
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
    }),
    prisma.aiWorkflow.findMany({
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
        url: true,
        events: true,
        description: true,
        // Exclude secret — never export secrets
        isActive: true,
      },
    }),
    prisma.knowledgeTag.findMany({
      select: {
        slug: true,
        name: true,
        description: true,
      },
    }),
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
        costLogRetentionDays: true,
        auditLogRetentionDays: true,
        maxConversationsPerUser: true,
        maxMessagesPerConversation: true,
        escalationConfig: true,
      },
    }),
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
            metadata: w.metadata,
          },
        ]
      : []
  );

  // Flatten agent grants into the slug/hash arrays the backup format expects.
  // `grantedTags`/`grantedDocuments` are include-shaped (join rows with one
  // nested entity each) — flatten them before serialising.
  const flattenedAgents = agents.map((a) => {
    const { grantedTags, grantedDocuments, knowledgeAccessMode, ...rest } = a;
    return {
      ...rest,
      // The DB column is `String`; coerce to the strict enum the backup schema wants.
      knowledgeAccessMode:
        knowledgeAccessMode === 'restricted' ? ('restricted' as const) : ('full' as const),
      // `knowledgeCategories` was dropped from the DB in Phase 6 but the
      // backup schema keeps the field on the wire for older importers
      // that still read it. Always emit empty.
      knowledgeCategories: [] as string[],
      grantedTagSlugs: grantedTags.map((g) => g.tag.slug),
      grantedDocumentHashes: grantedDocuments.map((g) => g.document.fileHash),
    };
  });

  return {
    schemaVersion: 2 as const,
    exportedAt: new Date().toISOString(),
    data: {
      agents: flattenedAgents,
      capabilities,
      workflows: flattenedWorkflows,
      webhooks,
      knowledgeTags,
      settings,
    },
  };
}
