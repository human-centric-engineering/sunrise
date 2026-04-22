/**
 * Admin Orchestration — Agents (list + create)
 *
 * GET  /api/v1/admin/orchestration/agents  — paginated list with filters
 * POST /api/v1/admin/orchestration/agents  — create a new agent
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { ConflictError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { createAgentSchema, listAgentsQuerySchema } from '@/lib/validations/orchestration';
import { getMonthToDateGlobalSpend } from '@/lib/orchestration/llm/cost-tracker';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { logger } from '@/lib/logging';
import type { BudgetSummary } from '@/types/orchestration';

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);

  const { searchParams } = new URL(request.url);
  const { page, limit, isActive, provider, q } = validateQueryParams(
    searchParams,
    listAgentsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiAgentWhereInput = {};
  if (isActive !== undefined) where.isActive = isActive;
  if (provider) where.provider = provider;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [rawAgents, total] = await Promise.all([
    prisma.aiAgent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        _count: { select: { capabilities: true, conversations: true } },
        creator: { select: { name: true } },
      },
    }),
    prisma.aiAgent.count({ where }),
  ]);

  let budgetMap: Record<string, BudgetSummary> = {};
  if (rawAgents.length > 0) {
    try {
      const agentIds = rawAgents.map((a) => a.id);
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

      const [spendGroups, settings] = await Promise.all([
        prisma.aiCostLog.groupBy({
          by: ['agentId'],
          where: { agentId: { in: agentIds }, createdAt: { gte: monthStart } },
          _sum: { totalCostUsd: true },
        }),
        prisma.aiOrchestrationSettings.findUnique({
          where: { slug: 'global' },
          select: { globalMonthlyBudgetUsd: true },
        }),
      ]);

      let globalCapExceeded = false;
      const globalCap = settings?.globalMonthlyBudgetUsd ?? null;
      if (globalCap !== null) {
        const globalSpent = await getMonthToDateGlobalSpend();
        globalCapExceeded = globalSpent >= globalCap;
      }

      const spendByAgent = new Map(spendGroups.map((g) => [g.agentId, g._sum.totalCostUsd ?? 0]));

      budgetMap = Object.fromEntries(
        rawAgents.map((agent) => {
          const spent = spendByAgent.get(agent.id) ?? 0;
          const limit = agent.monthlyBudgetUsd;
          const withinAgentBudget = limit === null ? true : spent < limit;
          const summary: BudgetSummary = {
            withinBudget: withinAgentBudget && !globalCapExceeded,
            spent,
            limit: limit ?? null,
            remaining: limit !== null ? limit - spent : null,
            ...(globalCapExceeded ? { globalCapExceeded: true } : {}),
          };
          return [agent.id, summary];
        })
      );
    } catch (err) {
      logger.warn('Agents list: batch budget lookup failed, returning null budgets', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const agents = rawAgents.map((agent) => ({
    ...agent,
    _budget: budgetMap[agent.id] ?? null,
  }));

  log.info('Agents listed', { count: agents.length, total, page, limit });

  return paginatedResponse(agents, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createAgentSchema);

  try {
    const agent = await prisma.aiAgent.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description,
        systemInstructions: body.systemInstructions,
        systemInstructionsHistory: [],
        model: body.model,
        provider: body.provider,
        providerConfig: (body.providerConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        monthlyBudgetUsd: body.monthlyBudgetUsd ?? null,
        metadata: (body.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        isActive: body.isActive,
        inputGuardMode: body.inputGuardMode ?? null,
        outputGuardMode: body.outputGuardMode ?? null,
        maxHistoryTokens: body.maxHistoryTokens ?? null,
        retentionDays: body.retentionDays ?? null,
        visibility: body.visibility ?? 'internal',
        rateLimitRpm: body.rateLimitRpm ?? null,
        fallbackProviders: body.fallbackProviders ?? [],
        knowledgeCategories: body.knowledgeCategories ?? [],
        topicBoundaries: body.topicBoundaries ?? [],
        brandVoiceInstructions: body.brandVoiceInstructions ?? null,
        createdBy: session.user.id,
      },
    });

    log.info('Agent created', {
      agentId: agent.id,
      slug: agent.slug,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'agent.create',
      entityType: 'agent',
      entityId: agent.id,
      entityName: agent.name,
      clientIp: clientIP,
    });

    return successResponse(agent, undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`Agent with slug '${body.slug}' already exists`);
    }
    throw err;
  }
});
