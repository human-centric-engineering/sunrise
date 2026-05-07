/**
 * Admin Orchestration — Fetch a single workflow version
 *
 * GET /api/v1/admin/orchestration/workflows/:id/versions/:version
 *
 * `:version` is the integer version label, not the row id. Used by the
 * builder's diff / version-detail views.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getVersion } from '@/lib/orchestration/workflows/version-service';
import { cuidSchema } from '@/lib/validations/common';

const versionParamSchema = z.coerce.number().int().min(1);

export const GET = withAdminAuth<{ id: string; version: string }>(
  async (request, _session, { params }) => {
    const clientIP = getClientIP(request);
    const rateLimit = adminLimiter.check(clientIP);
    if (!rateLimit.success) return createRateLimitResponse(rateLimit);

    const log = await getRouteLogger(request);
    const { id: rawId, version: rawVersion } = await params;

    const idParsed = cuidSchema.safeParse(rawId);
    if (!idParsed.success) {
      throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
    }

    const versionParsed = versionParamSchema.safeParse(rawVersion);
    if (!versionParsed.success) {
      throw new ValidationError('Invalid version', {
        version: ['Must be a positive integer'],
      });
    }

    const row = await getVersion(idParsed.data, versionParsed.data);

    log.info('Workflow version fetched', {
      workflowId: idParsed.data,
      version: versionParsed.data,
    });

    return successResponse(row);
  }
);
