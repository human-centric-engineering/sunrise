/**
 * What support did under an org's grants (§121 t-825)
 *
 * GET /api/v1/orgs/[id]/support-grants/activity?grantId=&page=&limit= — the
 *     admin audit rows made inside support sessions in this org, newest first,
 *     optionally one grant's. Each names the action, what it touched, who did
 *     it and the grant.
 *
 * The same admission as the grant list beside it: the org's OWNER/ADMIN
 * acting in it, or a platform admin. The rows are system-model rows, so the
 * read itself requires the grant to be this org's (`listSupportActivity`): a
 * `grantId` belonging to another org returns nothing.
 *
 * A browser session only, as on the grant routes.
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { paginatedResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { listSupportActivityQuerySchema, orgIdParamSchema } from '@/lib/validations/tenancy';
import { resolveOrgResource } from '@/lib/tenancy/lifecycle';
import { listSupportActivity } from '@/lib/tenancy/support-grants';
import { getRouteLogger } from '@/lib/api/context';

export const GET = withAuth<{ id: string }>(
  async (request, session, { params }) => {
    if (isApiKeySession(session)) {
      const log = await getRouteLogger(request);
      log.warn('Rejected API-key attempt to read support activity', { userId: session.user.id });
      throw new ForbiddenError('Reading support activity requires a browser session');
    }

    const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
    const { page, limit, grantId } = validateQueryParams(
      new URL(request.url).searchParams,
      listSupportActivityQuerySchema
    );

    const { entries, total } = await listSupportActivity(id, { grantId, page, limit });
    return paginatedResponse(entries, { page, limit, total });
  },
  {
    resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) =>
      resolveOrgResource(await context?.params),
    ownership: {
      decidedBy: 'resource',
      because:
        'The policy admitted the caller to the org the URL names; the read is bounded to rows made under that org’s own grants.',
    },
  }
);
