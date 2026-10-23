/**
 * Admin Orchestration — Publish workflow draft
 *
 * POST /api/v1/admin/orchestration/workflows/:id/publish
 *
 * Promotes the in-progress `draftDefinition` to a new immutable
 * `AiWorkflowVersion` and pins `publishedVersionId` to it. Atomic;
 * runs Zod + structural + semantic validation before writing. Requires
 * `If-Match`: the `definitionVersion` the builder loaded (428 without, 412
 * when it has moved on, §122 t-900).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { requireIfMatch } from '@/lib/api/record-version';
import { publishDraft } from '@/lib/orchestration/workflows/version-service';
import { publishWorkflowSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success) {
      throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
    }
    const id = parsed.data;

    const loadedAt = requireIfMatch(request);
    const body = await validateRequestBody(request, publishWorkflowSchema);

    const result = await publishDraft({
      workflowId: id,
      loadedAt,
      userId: session.user.id,
      changeSummary: body.changeSummary,
      clientIp: clientIP,
    });

    log.info('Workflow draft published', {
      workflowId: id,
      versionId: result.version.id,
      version: result.version.version,
      adminId: session.user.id,
    });

    // The builder's next save is checked against this: the draft is gone and
    // the new version is published.
    return successResponse({
      workflow: result.workflow,
      version: result.version,
      definitionVersion: result.definitionVersion,
    });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Workflows, their versions, schedules and templates are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
