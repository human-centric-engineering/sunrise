/**
 * Orchestration Config Importer
 *
 * Validates and imports a backup payload, upserting by slug.
 * Runs in a transaction so partial failures roll back cleanly.
 * Excludes secrets with a warning.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { backupSchema } from '@/lib/orchestration/backup/schema';

export interface ImportResult {
  agents: { created: number; updated: number };
  capabilities: { created: number; updated: number };
  workflows: { created: number; updated: number };
  webhooks: { created: number; skipped: number };
  settingsUpdated: boolean;
  warnings: string[];
}

export async function importOrchestrationConfig(
  raw: unknown,
  userId: string
): Promise<ImportResult> {
  const parsed = backupSchema.parse(raw);

  const result: ImportResult = {
    agents: { created: 0, updated: 0 },
    capabilities: { created: 0, updated: 0 },
    workflows: { created: 0, updated: 0 },
    webhooks: { created: 0, skipped: 0 },
    settingsUpdated: false,
    warnings: [],
  };

  await prisma.$transaction(async (tx) => {
    // Import agents by slug upsert
    for (const agent of parsed.data.agents) {
      const existing = await tx.aiAgent.findUnique({ where: { slug: agent.slug } });
      if (existing) {
        await tx.aiAgent.update({
          where: { slug: agent.slug },
          data: {
            name: agent.name,
            description: agent.description,
            systemInstructions: agent.systemInstructions,
            model: agent.model,
            provider: agent.provider,
            fallbackProviders: agent.fallbackProviders,
            temperature: agent.temperature,
            maxTokens: agent.maxTokens,
            monthlyBudgetUsd: agent.monthlyBudgetUsd,
            visibility: agent.visibility,
            isActive: agent.isActive,
            metadata: (agent.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            knowledgeCategories: agent.knowledgeCategories,
            topicBoundaries: agent.topicBoundaries,
            brandVoiceInstructions: agent.brandVoiceInstructions,
          },
        });
        result.agents.updated++;
      } else {
        await tx.aiAgent.create({
          data: {
            ...agent,
            metadata: (agent.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            createdBy: userId,
          },
        });
        result.agents.created++;
      }
    }

    // Import capabilities by slug upsert
    for (const cap of parsed.data.capabilities) {
      const existing = await tx.aiCapability.findUnique({ where: { slug: cap.slug } });
      if (existing) {
        await tx.aiCapability.update({
          where: { slug: cap.slug },
          data: {
            name: cap.name,
            description: cap.description,
            category: cap.category,
            functionDefinition: cap.functionDefinition as Prisma.InputJsonValue,
            executionType: cap.executionType,
            executionHandler: cap.executionHandler,
            executionConfig: (cap.executionConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            requiresApproval: cap.requiresApproval,
            rateLimit: cap.rateLimit,
            isActive: cap.isActive,
          },
        });
        result.capabilities.updated++;
      } else {
        await tx.aiCapability.create({
          data: {
            ...cap,
            functionDefinition: cap.functionDefinition as Prisma.InputJsonValue,
            executionConfig: (cap.executionConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          },
        });
        result.capabilities.created++;
      }
    }

    // Import workflows by slug upsert
    for (const wf of parsed.data.workflows) {
      const existing = await tx.aiWorkflow.findUnique({ where: { slug: wf.slug } });
      if (existing) {
        await tx.aiWorkflow.update({
          where: { slug: wf.slug },
          data: {
            name: wf.name,
            description: wf.description,
            workflowDefinition: wf.workflowDefinition as Prisma.InputJsonValue,
            patternsUsed: wf.patternsUsed,
            isActive: wf.isActive,
            isTemplate: wf.isTemplate,
            metadata: (wf.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          },
        });
        result.workflows.updated++;
      } else {
        await tx.aiWorkflow.create({
          data: {
            ...wf,
            workflowDefinition: wf.workflowDefinition as Prisma.InputJsonValue,
            metadata: (wf.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            createdBy: userId,
          },
        });
        result.workflows.created++;
      }
    }

    // Import webhooks — skip duplicates by url
    for (const wh of parsed.data.webhooks) {
      const existing = await tx.aiWebhookSubscription.findFirst({
        where: { url: wh.url },
      });
      if (existing) {
        result.webhooks.skipped++;
        continue;
      }
      result.warnings.push(
        `Webhook for ${wh.url} imported inactive — set the signing secret and re-enable manually`
      );
      await tx.aiWebhookSubscription.create({
        data: {
          url: wh.url,
          events: wh.events,
          description: wh.description ?? null,
          secret: '', // Secrets are never exported
          isActive: false, // Force inactive: empty secret would sign dispatches with an empty HMAC key
          createdBy: userId,
        },
      });
      result.webhooks.created++;
    }

    // Import settings
    if (parsed.data.settings) {
      const s = parsed.data.settings;
      await tx.aiOrchestrationSettings.upsert({
        where: { slug: 'global' },
        create: {
          slug: 'global',
          defaultModels: s.defaultModels as Prisma.InputJsonValue,
          globalMonthlyBudgetUsd: s.globalMonthlyBudgetUsd,
          searchConfig: (s.searchConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          defaultApprovalTimeoutMs: s.defaultApprovalTimeoutMs,
          approvalDefaultAction: s.approvalDefaultAction,
          inputGuardMode: s.inputGuardMode,
          outputGuardMode: s.outputGuardMode,
          webhookRetentionDays: s.webhookRetentionDays,
          costLogRetentionDays: s.costLogRetentionDays,
          auditLogRetentionDays: s.auditLogRetentionDays,
          maxConversationsPerUser: s.maxConversationsPerUser,
          maxMessagesPerConversation: s.maxMessagesPerConversation,
          escalationConfig: (s.escalationConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        },
        update: {
          defaultModels: s.defaultModels as Prisma.InputJsonValue,
          globalMonthlyBudgetUsd: s.globalMonthlyBudgetUsd,
          searchConfig: (s.searchConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          defaultApprovalTimeoutMs: s.defaultApprovalTimeoutMs,
          approvalDefaultAction: s.approvalDefaultAction,
          inputGuardMode: s.inputGuardMode,
          outputGuardMode: s.outputGuardMode,
          webhookRetentionDays: s.webhookRetentionDays,
          costLogRetentionDays: s.costLogRetentionDays,
          auditLogRetentionDays: s.auditLogRetentionDays,
          maxConversationsPerUser: s.maxConversationsPerUser,
          maxMessagesPerConversation: s.maxMessagesPerConversation,
          escalationConfig: (s.escalationConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        },
      });
      result.settingsUpdated = true;
    }
  });

  logger.info('Orchestration config imported', { ...result });
  return result;
}
