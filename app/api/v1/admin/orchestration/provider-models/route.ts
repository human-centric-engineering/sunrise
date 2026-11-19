/**
 * Admin Orchestration — Provider Models (list + create)
 *
 * GET  /api/v1/admin/orchestration/provider-models — paginated list
 *      with optional `configuredProvider` enrichment from AiProviderConfig.
 *      Supports filtering by capability, providerSlug, tierRole, isActive, q.
 * POST /api/v1/admin/orchestration/provider-models — create a new model entry.
 *      Admin-created models are marked `isDefault: false`.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { withAdminAuth } from '@/lib/auth/guards';
import { administersPlatform } from '@/lib/auth/admin-viewer';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { ConflictError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { defaultSlots, settingsPinsFor } from '@/lib/orchestration/model-lifecycle/settings-pins';
import {
  listProviderModelsQuerySchema,
  createProviderModelSchema,
} from '@/lib/validations/orchestration';
import { modelAgentUsage, modelUsageKey } from '@/lib/orchestration/admin/global-config-usage';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

export const GET = withAdminAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);

    const { searchParams } = new URL(request.url);
    const { page, limit, isActive, tierRole, capability, providerSlug, q } = validateQueryParams(
      searchParams,
      listProviderModelsQuerySchema
    );
    const skip = (page - 1) * limit;

    const where: Prisma.AiProviderModelWhereInput = {};
    if (isActive !== undefined) where.isActive = isActive;
    if (tierRole) where.tierRole = tierRole;
    if (providerSlug) where.providerSlug = providerSlug;
    if (capability) where.capabilities = { has: capability };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        { providerSlug: { contains: q, mode: 'insensitive' } },
        { modelId: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [rows, total, providerConfigs, settings] = await Promise.all([
      prisma.aiProviderModel.findMany({
        where,
        orderBy: [{ providerSlug: 'asc' }, { name: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.aiProviderModel.count({ where }),
      // Look up which providers have a matching AiProviderConfig
      prisma.aiProviderConfig.findMany({
        select: { slug: true, isActive: true },
      }),
      // Resolve the effective default-models map so each row can advertise
      // any TaskType slot it currently fills (routing/chat/reasoning/
      // embeddings). Agents with empty provider/model fall back to these
      // defaults at runtime, so a model serving a default is implicitly
      // in use even when no agent directly names it.
      getOrchestrationSettings(),
    ]);

    // Bound active agents per (provider, modelId) pair, in every org (§107
    // t-752): the caller's by name, other orgs' counted. Scoped to the slugs
    // in the current page so a 100-row matrix doesn't drag the entire
    // AiAgent table across the wire.
    // Other orgs' usage is counted for a platform admin's delete check. A
    // customer org's admin sees only their own org's (§111 t-811): how many
    // of another tenant's agents use a shared row is not theirs to know.
    const platform = await administersPlatform(session.principal);
    const usage = await modelAgentUsage(
      [...new Set(rows.map((r) => r.providerSlug))],
      [...new Set(rows.map((r) => r.modelId))]
    );

    const configBySlug = new Map(providerConfigs.map((c) => [c.slug, c]));

    // Task slots each row serves as the effective default, by the one
    // matching rule the model's uses page applies too (`settingsPinsFor`).
    const data = rows.map((model) => {
      const config = configBySlug.get(model.providerSlug);
      const used = usage.get(modelUsageKey(model.providerSlug, model.modelId));
      const defaultFor = defaultSlots(settingsPinsFor(model, settings));
      return {
        ...model,
        configured: !!config,
        configuredActive: config?.isActive ?? false,
        agents: used?.agents ?? [],
        // Active agents in other orgs bound to it. Counted, never named; the
        // delete is refused while this or `agents` is non-zero.
        otherOrgAgentCount: platform ? (used?.otherOrgAgents ?? 0) : 0,
        // Task slots this model serves as the effective system default
        // (routing/chat/reasoning/embeddings/audio). Agents with empty
        // provider/model inherit these at runtime.
        defaultFor,
      };
    });

    log.info('Provider models listed', {
      count: rows.length,
      total,
      page,
      limit,
      modelsInUse: data.filter((m) => m.agents.length + m.otherOrgAgentCount > 0).length,
      modelsServingDefaults: data.filter((m) => m.defaultFor.length > 0).length,
    });

    return paginatedResponse(data, { page, limit, total });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because: 'Shared configuration every org reads; it holds nobody’s personal rows.',
    },
  }
);

export const POST = withAdminAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    const body = await validateRequestBody(request, createProviderModelSchema);

    try {
      const model = await prisma.aiProviderModel.create({
        data: {
          name: body.name,
          slug: body.slug,
          providerSlug: body.providerSlug,
          modelId: body.modelId,
          description: body.description,
          capabilities: body.capabilities,
          tierRole: body.tierRole,
          reasoningDepth: body.reasoningDepth,
          latency: body.latency,
          costEfficiency: body.costEfficiency,
          contextLength: body.contextLength,
          toolUse: body.toolUse,
          paramProfile: body.paramProfile ?? null,
          bestRole: body.bestRole,
          dimensions: body.dimensions ?? null,
          schemaCompatible: body.schemaCompatible ?? null,
          costPerMillionTokens: body.costPerMillionTokens ?? null,
          inputCostPerMillionTokens: body.inputCostPerMillionTokens ?? null,
          outputCostPerMillionTokens: body.outputCostPerMillionTokens ?? null,
          hasFreeTier: body.hasFreeTier ?? null,
          local: body.local,
          quality: body.quality ?? null,
          strengths: body.strengths ?? null,
          setup: body.setup ?? null,
          isDefault: false, // admin-created models are never re-seedable
          isActive: body.isActive,
          metadata: (body.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          createdBy: session.user.id,
        },
      });

      invalidateModelCache();

      log.info('Provider model created', {
        modelId: model.id,
        slug: model.slug,
        adminId: session.user.id,
      });

      // §136 t-1064: every catalogue change is in the admin audit log.
      logAdminAction({
        userId: session.user.id,
        action: 'provider_model.create',
        entityType: 'provider_model',
        entityId: model.id,
        entityName: model.name,
        metadata: {
          providerSlug: model.providerSlug,
          modelId: model.modelId,
          inputCostPerMillionTokens: model.inputCostPerMillionTokens,
          outputCostPerMillionTokens: model.outputCostPerMillionTokens,
        },
        clientIp: getClientIP(request),
      });

      return successResponse(model, undefined, { status: 201 });
    } catch (err) {
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.providerModelSlug)) {
        throw new ConflictError(`Provider model with slug '${body.slug}' already exists`);
      }
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.providerModelPair)) {
        throw new ConflictError(
          `Provider '${body.providerSlug}' already has a model with id '${body.modelId}'`
        );
      }
      throw err;
    }
  },
  { writesSharedSettings: true }
);
