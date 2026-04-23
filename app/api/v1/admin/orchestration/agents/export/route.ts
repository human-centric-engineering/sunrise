/**
 * Admin Orchestration — Export agents bundle
 *
 * POST /api/v1/admin/orchestration/agents/export
 *   Body: { agentIds: string[] }
 *   Returns a versioned `AgentBundle` containing the selected agents and
 *   their attached capabilities (by slug). Server-owned fields (`id`,
 *   `createdAt`, `updatedAt`, `createdBy`) are stripped so the bundle is
 *   portable across environments.
 *
 *   The response sets `Content-Disposition: attachment` so hitting the
 *   route directly from a browser triggers a "Save As" dialog.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logger } from '@/lib/logging';
import {
  exportAgentsSchema,
  systemInstructionsHistorySchema,
  type AgentBundle,
  type SystemInstructionsHistoryEntry,
} from '@/lib/validations/orchestration';

const jsonRecord = z.record(z.string(), z.unknown()).nullable().catch(null);

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, exportAgentsSchema);
  const uniqueIds = [...new Set(body.agentIds)];

  const agents = await prisma.aiAgent.findMany({
    where: { id: { in: uniqueIds } },
    include: {
      capabilities: {
        include: {
          capability: { select: { slug: true } },
        },
      },
    },
  });

  if (agents.length !== uniqueIds.length) {
    const foundIds = new Set(agents.map((a) => a.id));
    const missing = uniqueIds.filter((id) => !foundIds.has(id));
    throw new NotFoundError(`Agents not found: ${missing.join(', ')}`);
  }

  const bundle: AgentBundle = {
    version: '1',
    exportedAt: new Date().toISOString(),
    agents: agents.map((agent) => {
      const historyParse = systemInstructionsHistorySchema.safeParse(
        agent.systemInstructionsHistory
      );
      const history: SystemInstructionsHistoryEntry[] = historyParse.success
        ? historyParse.data
        : [];
      if (!historyParse.success) {
        logger.warn('export: systemInstructionsHistory malformed, exporting empty array', {
          agentId: agent.id,
          issues: historyParse.error.issues,
        });
      }

      return {
        name: agent.name,
        slug: agent.slug,
        isSystem: agent.isSystem,
        description: agent.description,
        systemInstructions: agent.systemInstructions,
        systemInstructionsHistory: history,
        model: agent.model,
        provider: agent.provider,
        providerConfig: jsonRecord.parse(agent.providerConfig),
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
        monthlyBudgetUsd: agent.monthlyBudgetUsd,
        metadata: jsonRecord.parse(agent.metadata),
        isActive: agent.isActive,
        fallbackProviders: agent.fallbackProviders,
        rateLimitRpm: agent.rateLimitRpm,
        inputGuardMode: agent.inputGuardMode as 'log_only' | 'warn_and_continue' | 'block' | null,
        outputGuardMode: agent.outputGuardMode as 'log_only' | 'warn_and_continue' | 'block' | null,
        maxHistoryTokens: agent.maxHistoryTokens,
        retentionDays: agent.retentionDays,
        visibility: agent.visibility as 'internal' | 'public' | 'invite_only',
        knowledgeCategories: agent.knowledgeCategories,
        topicBoundaries: agent.topicBoundaries,
        brandVoiceInstructions: agent.brandVoiceInstructions,
        capabilities: agent.capabilities.map((link) => ({
          slug: link.capability.slug,
          isEnabled: link.isEnabled,
          customConfig: jsonRecord.parse(link.customConfig),
          customRateLimit: link.customRateLimit,
        })),
      };
    }),
  };

  log.info('Agents exported', {
    count: bundle.agents.length,
    adminId: session.user.id,
  });

  const filename = `agents-export-${bundle.exportedAt.replace(/:/g, '-')}.json`;
  return successResponse(bundle, undefined, {
    headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
  });
});
