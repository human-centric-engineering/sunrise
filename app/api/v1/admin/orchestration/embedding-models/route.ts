/**
 * Admin Orchestration — Embedding Models Registry
 *
 * GET /api/v1/admin/orchestration/embedding-models
 *
 * Returns a curated list of embedding models from the static registry,
 * optionally filtered by schema compatibility, free tier, or local.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { filterEmbeddingModels } from '@/lib/orchestration/llm/embedding-models';

const booleanQueryParam = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const embeddingModelsQuerySchema = z.object({
  schemaCompatibleOnly: booleanQueryParam,
  hasFreeTier: booleanQueryParam,
  local: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const GET = withAdminAuth((request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { searchParams } = new URL(request.url);
  const { schemaCompatibleOnly, hasFreeTier, local } = validateQueryParams(
    searchParams,
    embeddingModelsQuerySchema
  );

  const models = filterEmbeddingModels({ schemaCompatibleOnly, hasFreeTier, local });

  return successResponse(models);
});
