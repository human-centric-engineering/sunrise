/**
 * Admin Orchestration — Pattern detail
 *
 * GET /api/v1/admin/orchestration/knowledge/patterns/:number
 *
 * Returns every chunk associated with the given pattern number, sorted
 * by `section`. 404 when no chunks exist for the pattern.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getPatternDetail } from '@/lib/orchestration/knowledge/search';
import { getPatternParamSchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth<{ number: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { number: rawNumber } = await params;

  const parsed = getPatternParamSchema.safeParse({ number: rawNumber });
  if (!parsed.success) {
    throw new ValidationError('Invalid pattern number', {
      number: ['Must be a positive integer'],
    });
  }
  const { number } = parsed.data;

  const detail = await getPatternDetail(number);
  if (!detail || detail.chunks.length === 0) {
    throw new NotFoundError(`Pattern ${number} not found`);
  }

  log.info('Pattern detail fetched', { number, chunkCount: detail.chunks.length });

  return successResponse(detail);
});
