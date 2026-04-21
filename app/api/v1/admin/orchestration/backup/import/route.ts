/**
 * Admin Orchestration — Backup Import
 *
 * POST /api/v1/admin/orchestration/backup/import — import orchestration config from JSON
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { importOrchestrationConfig } from '@/lib/orchestration/backup/importer';
import { ZodError } from 'zod';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse('Request body must be valid JSON', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  try {
    const result = await importOrchestrationConfig(raw, session.user.id);

    logAdminAction({
      userId: session.user.id,
      action: 'backup.import',
      entityType: 'backup',
      entityId: 'full',
      metadata: {
        agents: result.agents,
        capabilities: result.capabilities,
        workflows: result.workflows,
        webhooks: result.webhooks,
        settingsUpdated: result.settingsUpdated,
        warningCount: result.warnings.length,
      },
      clientIp: clientIP,
    });

    log.info('Orchestration config imported', {
      adminId: session.user.id,
      result,
    });

    return successResponse(result);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse('Invalid backup payload', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { issues: err.issues },
      });
    }
    throw err;
  }
});
