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
import { getClientIP } from '@/lib/security/ip';
import { createAgentSchema, listAgentsQuerySchema } from '@/lib/validations/orchestration';
import { getMonthToDateGlobalSpend } from '@/lib/orchestration/llm/cost-tracker';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { notifyMcpAgentsChanged } from '@/lib/orchestration/mcp/resource-update-hooks';
import {
  INITIAL_VERSION_SUMMARY,
  asSnapshotJson,
  buildAgentSnapshot,
} from '@/lib/orchestration/agents/agent-versioning';
import { logger } from '@/lib/logging';
import type { BudgetSummary } from '@/types/orchestration';

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);

  const { searchParams } = new URL(request.url);
  const { page, limit, isActive, provider, isSystem, q, kind, profileId } = validateQueryParams(
    searchParams,
    listAgentsQuerySchema
  );
  const skip = (page - 1) * limit;

  // Optional kind filter. When the caller doesn't specify, return
  // every kind — judges and chat agents alike. The agents list page
  // renders a "Judge" badge alongside the existing "System" badge so
  // operators can tell them apart at a glance. Callers that want a
  // single kind (the run-create subject picker passes `kind=chat`;
  // the run-create metric picker passes `kind=judge`) opt in.
  const where: Prisma.AiAgentWhereInput = {};
  if (kind !== undefined) where.kind = kind;
  if (isActive !== undefined) where.isActive = isActive;
  // Hide soft-deleted agents. DELETE stamps `deletedAt = now()` (and
  // tombstones the slug to free the @unique constraint, but the timestamp
  // is the authoritative signal). We deliberately do not filter by
  // `isActive` here: a freshly cloned agent is created inactive (so the
  // operator can review it before going live), and a manually deactivated
  // agent should still appear so the operator can re-enable it.
  where.deletedAt = null;
  if (provider) where.provider = provider;
  if (isSystem !== undefined) where.isSystem = isSystem;
  if (profileId !== undefined) {
    where.profileId = profileId === 'none' ? null : profileId;
  }
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
      // Default "natural importance" sort:
      //   1. Bespoke before system — `false < true` in Postgres asc,
      //      so `isSystem: 'asc'` puts user-created rows on top.
      //   2. Most recently active first — `lastActiveAt desc` with nulls
      //      last so never-used agents settle at the bottom of each
      //      bucket. Bumped by `touchAgentLastActive` on conversation
      //      create/update and cost-log writes.
      //   3. Recently created as the final tiebreaker (covers never-
      //      used agents).
      orderBy: [
        { isSystem: 'asc' },
        { lastActiveAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      skip,
      take: limit,
      include: {
        _count: { select: { capabilities: true, conversations: true } },
        creator: { select: { name: true } },
        profile: { select: { id: true, name: true, slug: true, isSystem: true } },
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

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createAgentSchema);

  try {
    // Create the agent and its explicit `v1` ("Initial configuration") in one
    // transaction. The point-in-time version model makes the original config a
    // first-class, restorable entry from the moment the agent exists — so a
    // single later edit can always be rolled back, and "restore to v1" means the
    // factory state. A fresh agent has no knowledge grants yet, so the snapshot's
    // grant arrays are empty.
    const agent = await prisma.$transaction(async (tx) => {
      const created = await tx.aiAgent.create({
        data: {
          name: body.name,
          slug: body.slug,
          kind: body.kind,
          description: body.description,
          systemInstructions: body.systemInstructions,
          systemInstructionsHistory: [],
          model: body.model,
          provider: body.provider,
          providerConfig: (body.providerConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          reasoningEffort: body.reasoningEffort ?? null,
          monthlyBudgetUsd: body.monthlyBudgetUsd ?? null,
          maxCostPerTurnUsd: body.maxCostPerTurnUsd ?? null,
          metadata: (body.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          isActive: body.isActive,
          inputGuardMode: body.inputGuardMode ?? null,
          outputGuardMode: body.outputGuardMode ?? null,
          citationGuardMode: body.citationGuardMode ?? null,
          maxHistoryTokens: body.maxHistoryTokens ?? null,
          maxHistoryMessages: body.maxHistoryMessages ?? null,
          retentionDays: body.retentionDays ?? null,
          visibility: body.visibility ?? 'internal',
          rateLimitRpm: body.rateLimitRpm ?? null,
          fallbackProviders: body.fallbackProviders ?? [],
          topicBoundaries: body.topicBoundaries ?? [],
          knowledgeRetrievalMode: body.knowledgeRetrievalMode ?? 'model',
          knowledgeTriggerKeywords: body.knowledgeTriggerKeywords ?? [],
          brandVoiceInstructions: body.brandVoiceInstructions ?? null,
          profileId: body.profileId ?? null,
          persona: body.persona ?? null,
          guardrails: body.guardrails ?? null,
          personaMode: body.personaMode,
          voiceMode: body.voiceMode,
          guardrailsMode: body.guardrailsMode,
          enableVoiceInput: body.enableVoiceInput ?? false,
          enableImageInput: body.enableImageInput ?? false,
          enableDocumentInput: body.enableDocumentInput ?? false,
          runtimePromptManaged: body.runtimePromptManaged ?? false,
          runtimePromptNote: body.runtimePromptNote ?? null,
          createdBy: session.user.id,
        },
      });

      await tx.aiAgentVersion.create({
        data: {
          agentId: created.id,
          version: 1,
          snapshot: asSnapshotJson(
            buildAgentSnapshot(created, { grantedTagIds: [], grantedDocumentIds: [] })
          ),
          changeSummary: INITIAL_VERSION_SUMMARY,
          createdBy: session.user.id,
        },
      });

      return created;
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

    // MCP subscribers to sunrise://agents need to know the list changed.
    notifyMcpAgentsChanged();

    return successResponse(agent, undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`Agent with slug '${body.slug}' already exists`);
    }
    throw err;
  }
});
