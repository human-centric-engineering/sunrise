/**
 * Admin Orchestration — Backup Import
 *
 * POST /api/v1/admin/orchestration/backup/import — import orchestration config from JSON
 *
 * Authentication: Admin role required.
 *
 * Query (§109 t-738): `orgId` — the org to restore into, defaulting to the
 * active org (an unbound admin API key must name one at `multi`); `shared` —
 * whether to write capabilities, knowledge tags and the orchestration
 * settings. See `resolveBackupScope()`.
 *
 * Not `writesSharedSettings`, deliberately. A backup carries the shared part
 * beside the org's own agents and workflows, and declaring the option refused
 * the WHOLE import from a customer's org (t-751), so a customer could not
 * restore even its own agents. The rule is enforced here instead:
 * `resolveBackupScope()` refuses the shared part for any org but the install
 * org, and the importer writes it only when the resolved scope includes it.
 * `UNDECLARED_ROUTE_EXCEPTIONS` in `scripts/ci/shared-settings-writes.ts`
 * records that.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  importOrchestrationConfig,
  isWorkflowSlugConflict,
} from '@/lib/orchestration/backup/importer';
import { backupScopeQuerySchema, resolveBackupScope } from '@/lib/orchestration/backup/scope';
import { validateQueryParams } from '@/lib/api/validation';
import { ZodError } from 'zod';
import { ConflictError } from '@/lib/api/errors';
import { isAgentVersionConflict } from '@/lib/orchestration/agents/agent-versioning';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  // Resolved before the body is read, so a refused scope costs no parse.
  const query = validateQueryParams(new URL(request.url).searchParams, backupScopeQuerySchema);
  const scope = await resolveBackupScope(query, session.principal, 'import');

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
    const result = await importOrchestrationConfig(raw, session.user.id, scope);

    logAdminAction({
      userId: session.user.id,
      action: 'backup.import',
      entityType: 'backup',
      // The org the backup is of; `includesShared` says whether the shared part moved too.
      entityId: scope.orgId,
      metadata: {
        orgId: scope.orgId,
        includesShared: scope.includeShared,
        sharedSkipped: result.sharedSkipped,
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
    // to write, or another org took a workflow slug it planned to use. The
    // transaction rolled back, so the restore can be run again. Any other
    // unique violation is not retryable and goes to the shared API error
    // handler.
    if (isAgentVersionConflict(err) || isWorkflowSlugConflict(err)) {
      throw new ConflictError('Backup import conflicted with a concurrent change. Please retry.');
    }
    throw err;
  }
});
