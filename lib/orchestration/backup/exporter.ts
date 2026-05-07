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
  const [agents, capabilities, workflows, webhooks, settings] = await Promise.all([
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
        knowledgeCategories: true,
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

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data: {
      agents,
      capabilities,
      workflows: flattenedWorkflows,
      webhooks,
      settings,
    },
  };
}
