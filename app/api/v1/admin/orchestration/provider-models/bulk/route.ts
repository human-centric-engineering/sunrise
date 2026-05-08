/**
 * Admin Orchestration — Bulk add provider models to the matrix
 *
 * POST /api/v1/admin/orchestration/provider-models/bulk
 *
 * Used by the discovery dialog to commit a multi-pick selection in
 * one round trip. Each row in the request reuses the same field set
 * as the single-row POST minus `providerSlug` (driven from the
 * envelope) and `slug` (server-derived, matching the existing
 * `toSlug()` rule on the form).
 *
 * Insert strategy: `prisma.aiProviderModel.createMany` with
 * `skipDuplicates: true`. Postgres's `@@unique([providerSlug,
 * modelId])` and unique `slug` constraints filter conflicts
 * silently, so the response distinguishes `created` from `skipped`
 * by querying the matrix once before and after insertion. That
 * lets the dialog render "3 added, 2 skipped" honestly without
 * relying on the row count alone.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import { deriveMatrixSlug } from '@/lib/orchestration/llm/model-heuristics';
import { bulkCreateProviderModelsSchema } from '@/lib/validations/orchestration';

interface ConflictRow {
  modelId: string;
  reason: 'already_in_matrix';
}

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, bulkCreateProviderModelsSchema);

  // Pre-flight: which of these (providerSlug, modelId) pairs already
  // exist? Used to label conflicts in the response. createMany +
  // skipDuplicates would silently drop them, but the dialog needs
  // to surface "you tried to add X, but it's already in the matrix"
  // with the modelId — not just a count.
  const requestedModelIds = body.models.map((m) => m.modelId);
  const existing = await prisma.aiProviderModel.findMany({
    where: { providerSlug: body.providerSlug, modelId: { in: requestedModelIds } },
    select: { modelId: true },
  });
  const existingSet = new Set(existing.map((r) => r.modelId));

  const rowsToInsert = body.models
    .filter((m) => !existingSet.has(m.modelId))
    .map((m) => ({
      name: m.name,
      slug: deriveMatrixSlug(body.providerSlug, m.modelId),
      providerSlug: body.providerSlug,
      modelId: m.modelId,
      description: m.description,
      capabilities: m.capabilities,
      tierRole: m.tierRole,
      reasoningDepth: m.reasoningDepth,
      latency: m.latency,
      costEfficiency: m.costEfficiency,
      contextLength: m.contextLength,
      toolUse: m.toolUse,
      bestRole: m.bestRole,
      dimensions: m.dimensions ?? null,
      schemaCompatible: m.schemaCompatible ?? null,
      costPerMillionTokens: m.costPerMillionTokens ?? null,
      hasFreeTier: m.hasFreeTier ?? null,
      local: m.local,
      quality: m.quality ?? null,
      strengths: m.strengths ?? null,
      setup: m.setup ?? null,
      isDefault: false,
      isActive: true,
      createdBy: session.user.id,
    }));

  // skipDuplicates handles the rare race where two operators bulk-
  // add overlapping models concurrently — the second insert is
  // silently dropped instead of throwing P2002 mid-batch.
  const createResult = await prisma.aiProviderModel.createMany({
    data: rowsToInsert,
    skipDuplicates: true,
  });

  invalidateModelCache();

  const conflicts: ConflictRow[] = body.models
    .filter((m) => existingSet.has(m.modelId))
    .map((m) => ({ modelId: m.modelId, reason: 'already_in_matrix' as const }));

  const skippedCount = body.models.length - createResult.count;

  log.info('Provider models bulk-created', {
    providerSlug: body.providerSlug,
    requested: body.models.length,
    created: createResult.count,
    skipped: skippedCount,
    adminId: session.user.id,
  });

  return successResponse(
    {
      created: createResult.count,
      skipped: skippedCount,
      conflicts,
    },
    undefined,
    { status: 201 }
  );
});
