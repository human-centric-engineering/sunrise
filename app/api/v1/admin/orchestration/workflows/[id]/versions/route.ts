/**
 * Admin Orchestration — List workflow versions
 *
 * GET /api/v1/admin/orchestration/workflows/:id/versions
 *
 * Returns versions in descending order by `version` int. Cursor pagination
 * via the `cursor` query param (the id of the last row of the previous page).
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { listVersions } from '@/lib/orchestration/workflows/version-service';
import { cuidSchema } from '@/lib/validations/common';
import { workflowVersionIdSchema } from '@/lib/validations/orchestration';

const listVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Cursor is the id of the last version on the previous page — accepts the
  // same id formats as a version row (cuid for fresh rows, uuid for
  // migration-backfilled rows).
  cursor: workflowVersionIdSchema.optional(),
});

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // Existence check before listing — avoids returning an empty list for an
  // ID that doesn't exist (which would leak the difference between a deleted
  // workflow and one with no versions).
  const exists = await prisma.aiWorkflow.findUnique({
    where: { id },
    select: { id: true, publishedVersionId: true },
  });
  if (!exists) throw new NotFoundError(`Workflow ${id} not found`);

  const { searchParams } = new URL(request.url);
  const opts = validateQueryParams(searchParams, listVersionsQuerySchema);

  const result = await listVersions(id, opts);

  log.info('Workflow versions listed', { workflowId: id, count: result.versions.length });

  return successResponse({
    versions: result.versions,
    publishedVersionId: exists.publishedVersionId,
    nextCursor: result.nextCursor,
  });
});
