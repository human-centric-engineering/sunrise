/**
 * Admin Orchestration — Backup Import
 *
 * POST /api/v1/admin/orchestration/backup/import — import orchestration config from JSON
 *
 * Authentication: Admin role required.
 *
 * At `multi`, install org only (§107 t-751). A backup carries shared settings
 * — capabilities, knowledge tags, the orchestration settings — beside the
 * importing org's own agents and workflows, and the importer writes both. Until
 * §109 t-738 re-scopes it and splits the two, the whole import is refused from
 * a customer's org rather than letting it change settings every org reads.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { importOrchestrationConfig } from '@/lib/orchestration/backup/importer';
import { ZodError } from 'zod';
import { ConflictError } from '@/lib/api/errors';
import { isAgentVersionConflict } from '@/lib/orchestration/agents/agent-versioning';

export const POST = withAdminAuth(
  async (request, session) => {
    const clientIP = getClientIP(request);

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
      // A concurrent agent edit took a version number this restore was about
      // to write. The transaction rolled back, so the restore can be run again.
      // Any other unique violation is not retryable and goes to the shared API
      // error handler.
      if (isAgentVersionConflict(err)) {
        throw new ConflictError('Backup import conflicted with a concurrent change. Please retry.');
      }
      throw err;
    }
  },
  { writesSharedSettings: true }
);
