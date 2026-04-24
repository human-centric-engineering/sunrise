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
 * Authentication: Admin role required. Both GET and PATCH are rate-limited via
 * the shared `adminLimiter` — GET performs an upsert-on-read, so it is a
 * mutating endpoint despite the HTTP verb.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { computeETag, checkConditional } from '@/lib/api/etag';
import { computeDefaultModelMap } from '@/lib/orchestration/llm/model-registry';
import { invalidateSettingsCache } from '@/lib/orchestration/llm/settings-resolver';
import { updateOrchestrationSettingsSchema } from '@/lib/validations/orchestration';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  getOrchestrationSettings,
  hydrateSettings,
  parseStoredDefaults,
} from '@/lib/orchestration/settings';
import { TASK_TYPES, type TaskType } from '@/types/orchestration';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

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
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateOrchestrationSettingsSchema);

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
    updateData.defaultModels = mergedDefaults as unknown as Prisma.InputJsonValue;
  }
  if (body.globalMonthlyBudgetUsd !== undefined) {
    updateData.globalMonthlyBudgetUsd = body.globalMonthlyBudgetUsd;
  }
  if (body.searchConfig !== undefined) {
    updateData.searchConfig =
      body.searchConfig === null
        ? Prisma.JsonNull
        : (body.searchConfig as unknown as Prisma.InputJsonValue);
  }
  if (body.defaultApprovalTimeoutMs !== undefined) {
    updateData.defaultApprovalTimeoutMs = body.defaultApprovalTimeoutMs;
  }
  if (body.approvalDefaultAction !== undefined) {
    updateData.approvalDefaultAction = body.approvalDefaultAction;
  }
  if (body.inputGuardMode !== undefined) {
    updateData.inputGuardMode = body.inputGuardMode;
  }
  if (body.outputGuardMode !== undefined) {
    updateData.outputGuardMode = body.outputGuardMode;
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
  if (body.maxConversationsPerUser !== undefined) {
    updateData.maxConversationsPerUser = body.maxConversationsPerUser;
  }
  if (body.maxMessagesPerConversation !== undefined) {
    updateData.maxMessagesPerConversation = body.maxMessagesPerConversation;
  }
  if (body.escalationConfig !== undefined) {
    updateData.escalationConfig =
      body.escalationConfig === null
        ? Prisma.JsonNull
        : (body.escalationConfig as unknown as Prisma.InputJsonValue);
  }

  const row = await prisma.aiOrchestrationSettings.upsert({
    where: { slug: 'global' },
    create: {
      slug: 'global',
      defaultModels: mergedDefaults as unknown as Prisma.InputJsonValue,
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
    changes: computeChanges(
      (existing ?? {}) as Record<string, unknown>,
      row as unknown as Record<string, unknown>
    ),
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
