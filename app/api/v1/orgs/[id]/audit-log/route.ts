/**
 * An org's own admin history (t-1005, #1181)
 *
 * GET /api/v1/orgs/[id]/audit-log?page=&limit=&userId=&entityType=a,b — the
 *     admin audit rows belonging to this org, newest first: its members'
 *     actions, support's, and the vendor's changes to the org. Each names the
 *     action, what it touched, who did it, the diff, and whether it was made
 *     in a support session. `userId` and `entityType` only narrow.
 *
 * The same admission as the member list: the org's OWNER/ADMIN acting in it,
 * or a platform admin (the policy's org arm, `resolveOrgResource`). The rows
 * are system-model rows, so the read itself is bounded to this org
 * (`listOrgAuditLog`), not row isolation.
 *
 * A browser session only, as on the member list and support activity beside
 * it: every row names a person and what they did.
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { ForbiddenError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { listOrgAuditLogQuerySchema, orgIdParamSchema } from '@/lib/validations/tenancy';
import { resolveOrgResource } from '@/lib/tenancy/lifecycle';
import { listOrgAuditLog } from '@/lib/orchestration/audit/org-audit-log';

export const GET = withAuth<{ id: string }>(
  async (request, session, { params }) => {
    if (isApiKeySession(session)) {
      const log = await getRouteLogger(request);
      log.warn('Rejected API-key attempt to read an org audit log', { userId: session.user.id });
      throw new ForbiddenError('Reading the audit log requires a browser session');
    }

    const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
    const { page, limit, userId, entityType } = validateQueryParams(
      new URL(request.url).searchParams,
      listOrgAuditLogQuerySchema
    );

    const { entries, total } = await listOrgAuditLog(id, {
      page,
      limit,
      userId,
      entityTypes: entityType,
    });
    return paginatedResponse(entries, { page, limit, total });
  },
  {
    resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) =>
      resolveOrgResource(await context?.params),
    ownership: {
      decidedBy: 'resource',
      because:
        'The policy admitted the caller to the org the URL names; the read is bounded to rows made in that org.',
    },
  }
);
