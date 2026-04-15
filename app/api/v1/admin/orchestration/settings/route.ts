/**
 * Admin Orchestration — Settings singleton
 *
 * GET   /api/v1/admin/orchestration/settings — read the singleton row (upsert-on-read
 *       with computed defaults from the model registry). Lazy seed: no seeder touches
 *       this row, so admin edits survive re-seeds.
 * PATCH /api/v1/admin/orchestration/settings — partial update of `defaultModels` or
 *       `globalMonthlyBudgetUsd`. Validates every model id against the registry and
 *       invalidates the in-memory cache so the next chat turn picks up the change.
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
import { computeDefaultModelMap } from '@/lib/orchestration/llm/model-registry';
import { invalidateSettingsCache } from '@/lib/orchestration/llm/settings-resolver';
import { updateOrchestrationSettingsSchema } from '@/lib/validations/orchestration';
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
  log.info('Orchestration settings fetched', {
    hasGlobalCap: settings.globalMonthlyBudgetUsd !== null,
  });
  return successResponse(settings);
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

  const row = await prisma.aiOrchestrationSettings.upsert({
    where: { slug: 'global' },
    create: {
      slug: 'global',
      defaultModels: mergedDefaults as unknown as Prisma.InputJsonValue,
      globalMonthlyBudgetUsd: body.globalMonthlyBudgetUsd ?? null,
    },
    update: updateData,
  });

  invalidateSettingsCache();

  log.info('Orchestration settings updated', {
    adminId: session.user.id,
    changedKeys: Object.keys(body),
    globalCapSet: row.globalMonthlyBudgetUsd !== null,
  });

  return successResponse(hydrateSettings(row));
});
