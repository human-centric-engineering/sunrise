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
import { createInitialVersion } from '@/lib/orchestration/workflows/version-service';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

export interface ImportResult {
  agents: { created: number; updated: number };
  capabilities: { created: number; updated: number };
  workflows: { created: number; updated: number };
  webhooks: { created: number; skipped: number };
  knowledgeTags: { created: number; updated: number };
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
    knowledgeTags: { created: 0, updated: 0 },
    settingsUpdated: false,
    warnings: [],
  };

  await prisma.$transaction(async (tx) => {
    // Knowledge tags first — agents reference them by slug, so create/refresh
    // them before the agent import so grant resolution succeeds.
    const tagIdBySlug = new Map<string, string>();
    for (const tag of parsed.data.knowledgeTags ?? []) {
      const upserted = await tx.knowledgeTag.upsert({
        where: { slug: tag.slug },
        create: { slug: tag.slug, name: tag.name, description: tag.description ?? null },
        update: { name: tag.name, description: tag.description ?? null },
      });
      tagIdBySlug.set(upserted.slug, upserted.id);
      if (upserted.createdAt.getTime() === upserted.updatedAt.getTime()) {
        result.knowledgeTags.created++;
      } else {
        result.knowledgeTags.updated++;
      }
    }

    // v1 → v2 compatibility: when the backup is v1 (no `knowledgeTags`) but an
    // agent carries non-empty `knowledgeCategories`, infer tag slugs from those
    // strings so the new resolver model has something to work with.
    function slugifyFor(input: string): string {
      return input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    }
    if (parsed.schemaVersion === 1) {
      const inferredCategories = new Set<string>();
      for (const a of parsed.data.agents) {
        for (const c of a.knowledgeCategories ?? []) {
          if (c.trim()) inferredCategories.add(c.trim());
        }
      }
      for (const name of inferredCategories) {
        const slug = slugifyFor(name);
        if (!slug || tagIdBySlug.has(slug)) continue;
        const upserted = await tx.knowledgeTag.upsert({
          where: { slug },
          create: { slug, name },
          update: { name },
        });
        tagIdBySlug.set(slug, upserted.id);
        result.knowledgeTags.created++;
      }
    }

    // Import agents by slug upsert
    for (const agent of parsed.data.agents) {
      const existing = await tx.aiAgent.findUnique({ where: { slug: agent.slug } });
      if (existing) {
        if (existing.isSystem) {
          result.warnings.push(
            `System agent '${agent.slug}' skipped — system agents cannot be overwritten by backup import`
          );
          continue;
        }
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
            knowledgeAccessMode: agent.knowledgeAccessMode,
            topicBoundaries: agent.topicBoundaries,
            brandVoiceInstructions: agent.brandVoiceInstructions,
            rateLimitRpm: agent.rateLimitRpm,
            inputGuardMode: agent.inputGuardMode,
            outputGuardMode: agent.outputGuardMode,
            citationGuardMode: agent.citationGuardMode,
            maxHistoryTokens: agent.maxHistoryTokens,
            maxHistoryMessages: agent.maxHistoryMessages,
            retentionDays: agent.retentionDays,
            providerConfig: (agent.providerConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            widgetConfig: (agent.widgetConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          },
        });
        result.agents.updated++;
      } else {
        const {
          grantedTagSlugs: _ignoreTagSlugs,
          grantedDocumentHashes: _ignoreDocHashes,
          ...createAgent
        } = agent;
        await tx.aiAgent.create({
          data: {
            ...createAgent,
            metadata: (createAgent.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            providerConfig:
              (createAgent.providerConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            widgetConfig: (createAgent.widgetConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            createdBy: userId,
          },
        });
        result.agents.created++;
      }

      // Apply grants after upsert. For v1 backups (where the slug arrays are
      // empty and we synthesised tag rows from knowledgeCategories above),
      // fall back to looking up by category-derived slug so the agent ends up
      // with the same effective scope as before the migration.
      const target = await tx.aiAgent.findUnique({
        where: { slug: agent.slug },
        select: { id: true },
      });
      if (!target) continue; // upsert just succeeded — should never happen

      const tagSlugs =
        agent.grantedTagSlugs.length > 0
          ? agent.grantedTagSlugs
          : parsed.schemaVersion === 1
            ? (agent.knowledgeCategories ?? [])
                .map((c) => slugifyFor(c))
                .filter((s) => s.length > 0)
            : [];

      const resolvedTagIds: string[] = [];
      for (const slug of tagSlugs) {
        const tagId = tagIdBySlug.get(slug);
        if (tagId) {
          resolvedTagIds.push(tagId);
        } else {
          result.warnings.push(
            `Agent '${agent.slug}' references missing knowledge-tag slug '${slug}'; grant skipped`
          );
        }
      }

      await tx.aiAgentKnowledgeTag.deleteMany({ where: { agentId: target.id } });
      if (resolvedTagIds.length > 0) {
        await tx.aiAgentKnowledgeTag.createMany({
          data: resolvedTagIds.map((tagId) => ({ agentId: target.id, tagId })),
          skipDuplicates: true,
        });
      }

      // Document grants resolve via fileHash — content-derived, stable across envs.
      const docHashes = agent.grantedDocumentHashes ?? [];
      let resolvedDocIds: string[] = [];
      if (docHashes.length > 0) {
        const docs = await tx.aiKnowledgeDocument.findMany({
          where: { fileHash: { in: docHashes } },
          select: { id: true, fileHash: true },
        });
        const presentHashes = new Set(docs.map((d) => d.fileHash));
        for (const h of docHashes) {
          if (!presentHashes.has(h)) {
            result.warnings.push(
              `Agent '${agent.slug}' references missing knowledge document (fileHash ${h.slice(0, 12)}…); grant skipped`
            );
          }
        }
        resolvedDocIds = docs.map((d) => d.id);
      }
      await tx.aiAgentKnowledgeDocument.deleteMany({ where: { agentId: target.id } });
      if (resolvedDocIds.length > 0) {
        await tx.aiAgentKnowledgeDocument.createMany({
          data: resolvedDocIds.map((documentId) => ({ agentId: target.id, documentId })),
          skipDuplicates: true,
        });
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

    // Import workflows by slug upsert. The wire format carries one
    // `workflowDefinition` per workflow — on import it becomes either a
    // new published version (update path: published draft promoted to vN+1)
    // or the initial v1 (create path).
    for (const wf of parsed.data.workflows) {
      const defParsed = workflowDefinitionSchema.safeParse(wf.workflowDefinition);
      if (!defParsed.success) {
        result.warnings.push(`Workflow '${wf.slug}' skipped — definition failed validation`);
        continue;
      }
      const existing = await tx.aiWorkflow.findUnique({ where: { slug: wf.slug } });
      if (existing) {
        // Promote the imported snapshot to a new version on the existing workflow.
        const lastVersion = await tx.aiWorkflowVersion.findFirst({
          where: { workflowId: existing.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const newVersion = await tx.aiWorkflowVersion.create({
          data: {
            workflowId: existing.id,
            version: (lastVersion?.version ?? 0) + 1,
            snapshot: defParsed.data as unknown as Prisma.InputJsonValue,
            changeSummary: 'Imported from backup',
            createdBy: userId,
          },
        });
        await tx.aiWorkflow.update({
          where: { id: existing.id },
          data: {
            name: wf.name,
            description: wf.description,
            patternsUsed: wf.patternsUsed,
            isActive: wf.isActive,
            isTemplate: wf.isTemplate,
            metadata: (wf.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            publishedVersionId: newVersion.id,
          },
        });
        result.workflows.updated++;
      } else {
        const created = await tx.aiWorkflow.create({
          data: {
            name: wf.name,
            slug: wf.slug,
            description: wf.description,
            patternsUsed: wf.patternsUsed,
            isActive: wf.isActive,
            isTemplate: wf.isTemplate,
            metadata: (wf.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            createdBy: userId,
          },
        });
        await createInitialVersion({
          tx,
          workflowId: created.id,
          definition: defParsed.data,
          userId,
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
          citationGuardMode: s.citationGuardMode,
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
          citationGuardMode: s.citationGuardMode,
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
