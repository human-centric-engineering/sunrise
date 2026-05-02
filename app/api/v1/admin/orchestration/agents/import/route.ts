/**
 * Admin Orchestration — Import agents bundle
 *
 * POST /api/v1/admin/orchestration/agents/import
 *   Body: { bundle: AgentBundle, conflictMode?: 'skip' | 'overwrite' }
 *
 *   Per agent in the bundle:
 *     - If the slug already exists and `conflictMode === 'skip'`, leave
 *       it alone and record it in `results.skipped`.
 *     - If the slug already exists and `conflictMode === 'overwrite'`,
 *       update the row in place and rebuild its capability pivots.
 *     - Otherwise create the agent and attach its capabilities.
 *
 *   Capability slugs that don't exist in this environment are collected
 *   into `results.warnings` rather than failing the whole import — it's
 *   common for bundles to come from a superset environment.
 *
 *   Everything runs inside a single `prisma.$transaction`, so a partial
 *   failure rolls back the whole import. `capabilityDispatcher.clearCache()`
 *   is called once at the very end.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { importAgentsSchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { ValidationError } from '@/lib/api/errors';

type ImportResults = {
  imported: number;
  overwritten: number;
  skipped: number;
  warnings: string[];
};

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, importAgentsSchema);

  const { bundle, conflictMode } = body;

  // Reject bundles that contain duplicate slugs — they would cause a P2002
  // unique constraint violation partway through the transaction.
  const slugs = bundle.agents.map((a) => a.slug);
  const duplicateSlugs = [...new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))];
  if (duplicateSlugs.length > 0) {
    throw new ValidationError(`Duplicate slugs in import bundle: ${duplicateSlugs.join(', ')}`, {
      bundle: [`Duplicate slugs: ${duplicateSlugs.join(', ')}`],
    });
  }

  // Resolve capability slugs → ids up front so the transaction is short.
  const allCapabilitySlugs = Array.from(
    new Set(bundle.agents.flatMap((a) => a.capabilities.map((c) => c.slug)))
  );
  const capabilities = await prisma.aiCapability.findMany({
    where: { slug: { in: allCapabilitySlugs } },
    select: { id: true, slug: true },
  });
  const capabilityIdBySlug = new Map(capabilities.map((c) => [c.slug, c.id]));

  const results: ImportResults = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    warnings: [],
  };

  await prisma.$transaction(async (tx) => {
    for (const bundled of bundle.agents) {
      const existing = await tx.aiAgent.findUnique({ where: { slug: bundled.slug } });

      if (existing && conflictMode === 'skip') {
        results.skipped += 1;
        continue;
      }

      if (existing && existing.isSystem) {
        results.warnings.push(`Agent '${bundled.slug}': skipped — cannot overwrite system agent`);
        results.skipped += 1;
        continue;
      }

      // Resolve this agent's capability links, warning on unknown slugs.
      const pivotCreates: Prisma.AiAgentCapabilityCreateManyAgentInput[] = [];
      for (const cap of bundled.capabilities) {
        const capId = capabilityIdBySlug.get(cap.slug);
        if (!capId) {
          results.warnings.push(
            `Agent '${bundled.slug}': capability '${cap.slug}' not found — skipped`
          );
          continue;
        }
        pivotCreates.push({
          capabilityId: capId,
          isEnabled: cap.isEnabled,
          customConfig: (cap.customConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          customRateLimit: cap.customRateLimit ?? null,
        });
      }

      const agentData = {
        name: bundled.name,
        description: bundled.description,
        systemInstructions: bundled.systemInstructions,
        systemInstructionsHistory:
          bundled.systemInstructionsHistory as unknown as Prisma.InputJsonValue,
        model: bundled.model,
        provider: bundled.provider,
        providerConfig: (bundled.providerConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        temperature: bundled.temperature,
        maxTokens: bundled.maxTokens,
        monthlyBudgetUsd: bundled.monthlyBudgetUsd ?? null,
        metadata: (bundled.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        isActive: bundled.isActive,
        fallbackProviders: bundled.fallbackProviders ?? [],
        rateLimitRpm: bundled.rateLimitRpm ?? null,
        inputGuardMode: bundled.inputGuardMode ?? null,
        outputGuardMode: bundled.outputGuardMode ?? null,
        citationGuardMode: bundled.citationGuardMode ?? null,
        maxHistoryTokens: bundled.maxHistoryTokens ?? null,
        retentionDays: bundled.retentionDays ?? null,
        visibility: bundled.visibility ?? 'internal',
        knowledgeCategories: bundled.knowledgeCategories ?? [],
        topicBoundaries: bundled.topicBoundaries ?? [],
        brandVoiceInstructions: bundled.brandVoiceInstructions ?? null,
      };

      if (existing) {
        // Overwrite: update the row, drop old pivots, recreate new ones.
        await tx.aiAgent.update({
          where: { id: existing.id },
          data: agentData,
        });
        await tx.aiAgentCapability.deleteMany({ where: { agentId: existing.id } });
        if (pivotCreates.length > 0) {
          await tx.aiAgentCapability.createMany({
            data: pivotCreates.map((p) => ({ ...p, agentId: existing.id })),
          });
        }
        results.overwritten += 1;
      } else {
        const created = await tx.aiAgent.create({
          data: {
            ...agentData,
            slug: bundled.slug,
            createdBy: session.user.id,
          },
        });
        if (pivotCreates.length > 0) {
          await tx.aiAgentCapability.createMany({
            data: pivotCreates.map((p) => ({ ...p, agentId: created.id })),
          });
        }
        results.imported += 1;
      }
    }
  });

  capabilityDispatcher.clearCache();

  log.info('Agents imported', {
    ...results,
    conflictMode,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'agent.import',
    entityType: 'agent',
    entityId: 'bulk',
    entityName: `${results.imported} imported, ${results.overwritten} overwritten`,
    metadata: { ...results, conflictMode },
    clientIp: clientIP,
  });

  return successResponse(results);
});
