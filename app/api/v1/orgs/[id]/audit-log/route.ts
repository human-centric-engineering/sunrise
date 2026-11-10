/**
 * An org's own admin history (t-1005, #1181)
 *
 * GET /api/v1/orgs/[id]/audit-log?page=&limit= — the admin audit rows made in
 *     this org, newest first: its members' actions and support's alike. Each
 *     names the action, what it touched, who did it, the diff, and whether it
 *     was made in a support session.
 *
 * The same admission as the member list: the org's OWNER/ADMIN acting in it,
 * or a platform admin (the policy's org arm, `resolveOrgResource`). The rows
 * are system-model rows, so the read itself is bounded to this org
 * (`listOrgAuditLog`), not row isolation.
 */

import { withAuth } from '@/lib/auth/guards';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { listOrgAuditLogQuerySchema, orgIdParamSchema } from '@/lib/validations/tenancy';
import { resolveOrgResource } from '@/lib/tenancy/lifecycle';
import { listOrgAuditLog } from '@/lib/orchestration/audit/org-audit-log';

export const GET = withAuth<{ id: string }>(
  async (request, _session, { params }) => {
    const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
    const { page, limit } = validateQueryParams(
      new URL(request.url).searchParams,
      listOrgAuditLogQuerySchema
    );

    const { entries, total } = await listOrgAuditLog(id, { page, limit });
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
