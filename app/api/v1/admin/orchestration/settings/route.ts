/**
 * Admin Orchestration — Settings singleton
 *
 * GET   /api/v1/admin/orchestration/settings — read the singleton row (upsert-on-read
 *       with computed defaults from the model registry). Lazy seed: no seeder touches
 *       this row, so admin edits survive re-seeds.
 * PATCH /api/v1/admin/orchestration/settings — partial update of `defaultModels`,
 *       `globalMonthlyBudgetUsd`, or `searchConfig`. Validates every model id
 *       against the registry and invalidates the in-memory cache so the next chat
 *       turn picks up the change.
 *
 * Authentication: Admin role required. Both GET and PATCH are rate-limited
 * centrally by `proxy.ts` via the orchestration tier in the policy table at
 * `lib/security/rate-limit-policy.ts`. GET performs an upsert-on-read, so it
 * is a mutating endpoint despite the HTTP verb — the cap still applies.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { computeETag, checkConditional } from '@/lib/api/etag';
import { computeDefaultModelMap } from '@/lib/orchestration/llm/model-registry';
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';
import { invalidateSettingsCache } from '@/lib/orchestration/llm/settings-resolver';
import { getEmbeddingModels } from '@/lib/orchestration/llm/embedding-models';
import { parseAudioDefault } from '@/lib/orchestration/llm/audio-default';
import { updateOrchestrationSettingsSchema } from '@/lib/validations/orchestration';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  getOrchestrationSettings,
  hydrateSettings,
  parseStoredDefaults,
} from '@/lib/orchestration/settings';
import { TASK_TYPES, type TaskType } from '@/types/orchestration';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);
  const settings = await getOrchestrationSettings();

  const etag = computeETag(settings);
  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Orchestration settings fetched', {
    hasGlobalCap: settings.globalMonthlyBudgetUsd !== null,
  });
  return successResponse(settings, undefined, { headers: { ETag: etag } });
});

export const PATCH = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);

  // Hydrate the in-memory model registry from the DB-managed
  // `AiProviderModel` matrix BEFORE validating the body. The schema's
  // `defaultModels` refinement runs `validateTaskDefaults()` →
  // synchronous `getModel()`, which otherwise only sees the static +
  // OpenRouter-cached models. Operator-added rows (e.g. a date-stamped
  // `gpt-5.5-pro-2026-04-23` surfaced via model discovery) live only in
  // the DB, so without this hydration a model that the settings form
  // offers in its dropdown is rejected on save with `VALIDATION_ERROR`
  // (issue #302). Soft-fails internally, so a DB hiccup just leaves a
  // genuinely-unknown id to be rejected as before. Mirrors the other
  // model-id paths (workflow execute, cost estimation) that already
  // hydrate first.
  await hydrateModelRegistryFromDb();

  const body = await validateRequestBody(request, updateOrchestrationSettingsSchema);

  // Validate the active-embedding-model FK against the model matrix. The
  // Zod schema only enforces "non-empty string", since the foreign key
  // is a cuid we can't refine sync. The runtime needs an active embedding-
  // capable row with a non-null `dimensions` (the embedder enforces these
  // same gates in `resolveActiveEmbeddingConfig`), so reject early if any
  // gate fails — otherwise the failure only surfaces on the next chat
  // turn / search call.
  if (body.activeEmbeddingModelId !== undefined && body.activeEmbeddingModelId !== null) {
    const model = await prisma.aiProviderModel.findUnique({
      where: { id: body.activeEmbeddingModelId },
      select: { isActive: true, capabilities: true, dimensions: true },
    });
    if (
      !model ||
      !model.isActive ||
      !model.capabilities.includes('embedding') ||
      !model.dimensions ||
      model.dimensions <= 0
    ) {
      return errorResponse(
        'activeEmbeddingModelId must reference an active AiProviderModel with capability:"embedding" and a non-null `dimensions`',
        {
          code: 'VALIDATION_ERROR',
          status: 400,
          details: { field: 'activeEmbeddingModelId', value: body.activeEmbeddingModelId },
        }
      );
    }
  }

  // Defence-in-depth: validate the embeddings slot against the DB-backed
  // embedding-model registry. The Zod schema only enforces a non-empty
  // string here (the chat-only `getModel()` lookup that backs the other
  // task slots can't see embedding ids, and Zod refinements are sync), so
  // without this check an admin could PATCH any string into the slot and
  // the failure would only surface at the next chat turn that needs an
  // embedding. The form's dropdown sends the bare model id (e.g.
  // `text-embedding-3-small`), so we match against `EmbeddingModelInfo.model`.
  if (body.defaultModels?.embeddings) {
    const known = await getEmbeddingModels();
    const isKnown = known.some((m) => m.model === body.defaultModels!.embeddings);
    if (!isKnown) {
      return errorResponse('Unknown embedding model id', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: {
          task: 'embeddings',
          value: body.defaultModels.embeddings,
        },
      });
    }
  }

  // Audio is matrix-driven: the slot must point at an active
  // AiProviderModel row whose capabilities include 'audio'. The
  // hardcoded model-registry can't validate this (audio support is
  // declared per row, not in the registry), and Zod refinements are
  // sync, so the check runs here. Without it an admin could PATCH any
  // string and the failure would only surface when a voice request
  // hits the runtime and getAudioProvider() returns null.
  //
  // Stored values are `${providerSlug}::${modelId}` composites — see
  // `lib/orchestration/llm/audio-default.ts` for why. Legacy bare-
  // model-id values are accepted defensively (parser returns
  // providerSlug=null) so a row written before the composite landed
  // still validates against any matching audio matrix entry; the
  // next operator save rewrites with the composite.
  if (body.defaultModels?.audio) {
    const parsed = parseAudioDefault(body.defaultModels.audio);
    if (!parsed) {
      return errorResponse(
        'Audio default must be a non-empty `${providerSlug}::${modelId}` string',
        {
          code: 'VALIDATION_ERROR',
          status: 400,
          details: { task: 'audio', value: body.defaultModels.audio },
        }
      );
    }
    const where: Prisma.AiProviderModelWhereInput = {
      modelId: parsed.modelId,
      isActive: true,
      capabilities: { has: 'audio' },
    };
    if (parsed.providerSlug) {
      where.providerSlug = parsed.providerSlug;
    }
    const match = await prisma.aiProviderModel.findFirst({ where, select: { id: true } });
    if (!match) {
      return errorResponse(
        'Unknown audio model — add a row to the model matrix with capability:"audio" for this provider first',
        {
          code: 'VALIDATION_ERROR',
          status: 400,
          details: { task: 'audio', value: body.defaultModels.audio },
        }
      );
    }
  }

  // Merge patch into existing row. For `defaultModels` we start from computed
  // defaults (so missing keys always resolve), overlay the current row, then
  // overlay the patch.
  const existing = await prisma.aiOrchestrationSettings.findUnique({ where: { slug: 'global' } });
  const computed = computeDefaultModelMap();
  const currentDefaults: Record<string, string> = {
    ...computed,
    ...parseStoredDefaults(existing?.defaultModels),
  };
  const mergedDefaults: Record<TaskType, string> = { ...computed };
  for (const key of TASK_TYPES) {
    const val = currentDefaults[key];
    if (typeof val === 'string' && val.length > 0) mergedDefaults[key] = val;
  }
  if (body.defaultModels) {
    for (const [key, val] of Object.entries(body.defaultModels)) {
      if (TASK_TYPES.includes(key as TaskType) && typeof val === 'string') {
        mergedDefaults[key as TaskType] = val;
      }
    }
  }

  const updateData: Prisma.AiOrchestrationSettingsUpdateInput = {};
  if (body.defaultModels) {
    updateData.defaultModels = mergedDefaults;
  }
  if (body.globalMonthlyBudgetUsd !== undefined) {
    updateData.globalMonthlyBudgetUsd = body.globalMonthlyBudgetUsd;
  }
  if (body.searchConfig !== undefined) {
    updateData.searchConfig = body.searchConfig === null ? Prisma.JsonNull : body.searchConfig;
  }
  if (body.defaultApprovalTimeoutMs !== undefined) {
    updateData.defaultApprovalTimeoutMs = body.defaultApprovalTimeoutMs;
  }
  if (body.approvalDefaultAction !== undefined) {
    updateData.approvalDefaultAction = body.approvalDefaultAction;
  }
  if (body.voiceInputGloballyEnabled !== undefined) {
    updateData.voiceInputGloballyEnabled = body.voiceInputGloballyEnabled;
  }
  if (body.inputGuardMode !== undefined) {
    updateData.inputGuardMode = body.inputGuardMode;
  }
  if (body.outputGuardMode !== undefined) {
    updateData.outputGuardMode = body.outputGuardMode;
  }
  if (body.citationGuardMode !== undefined) {
    updateData.citationGuardMode = body.citationGuardMode;
  }
  if (body.webhookRetentionDays !== undefined) {
    updateData.webhookRetentionDays = body.webhookRetentionDays;
  }
  if (body.costLogRetentionDays !== undefined) {
    updateData.costLogRetentionDays = body.costLogRetentionDays;
  }
  if (body.auditLogRetentionDays !== undefined) {
    updateData.auditLogRetentionDays = body.auditLogRetentionDays;
  }
  if (body.executionRetentionDays !== undefined) {
    updateData.executionRetentionDays = body.executionRetentionDays;
  }
  if (body.evaluationRetentionDays !== undefined) {
    updateData.evaluationRetentionDays = body.evaluationRetentionDays;
  }
  if (body.maxConversationsPerUser !== undefined) {
    updateData.maxConversationsPerUser = body.maxConversationsPerUser;
  }
  if (body.maxMessagesPerConversation !== undefined) {
    updateData.maxMessagesPerConversation = body.maxMessagesPerConversation;
  }
  if (body.stuckExecutionThresholdMins !== undefined) {
    updateData.stuckExecutionThresholdMins = body.stuckExecutionThresholdMins;
  }
  if (body.defaultMaxCostPerExecutionUsd !== undefined) {
    updateData.defaultMaxCostPerExecutionUsd = body.defaultMaxCostPerExecutionUsd;
  }
  if (body.defaultMaxCostPerTurnUsd !== undefined) {
    updateData.defaultMaxCostPerTurnUsd = body.defaultMaxCostPerTurnUsd;
  }
  if (body.escalationConfig !== undefined) {
    updateData.escalationConfig =
      body.escalationConfig === null ? Prisma.JsonNull : body.escalationConfig;
  }
  if (body.embedAllowedOrigins !== undefined) {
    // Schema's `.transform` already normalised each entry to its
    // canonical `.origin` form — write straight through.
    updateData.embedAllowedOrigins = body.embedAllowedOrigins;
  }
  if (body.activeEmbeddingModelId !== undefined) {
    updateData.activeEmbeddingModel = body.activeEmbeddingModelId
      ? { connect: { id: body.activeEmbeddingModelId } }
      : { disconnect: true };
  }

  const row = await prisma.aiOrchestrationSettings.upsert({
    where: { slug: 'global' },
    create: {
      slug: 'global',
      defaultModels: mergedDefaults,
      globalMonthlyBudgetUsd: body.globalMonthlyBudgetUsd ?? null,
      searchConfig: body.searchConfig
        ? (body.searchConfig as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
    update: updateData,
  });

  invalidateSettingsCache();

  logAdminAction({
    userId: session.user.id,
    action: 'settings.update',
    entityType: 'settings',
    entityId: 'global',
    changes: computeChanges(existing ?? {}, row),
    metadata: { changedKeys: Object.keys(body) },
    clientIp: clientIP,
  });

  log.info('Orchestration settings updated', {
    adminId: session.user.id,
    changedKeys: Object.keys(body),
    globalCapSet: row.globalMonthlyBudgetUsd !== null,
  });

  return successResponse(hydrateSettings(row));
});
