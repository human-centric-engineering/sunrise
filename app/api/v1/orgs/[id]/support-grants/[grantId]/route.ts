/**
 * Revoke one of an org's support grants (§121 t-823)
 *
 * DELETE /api/v1/orgs/[id]/support-grants/[grantId] — ends the grant now.
 *
 * Admitted by the policy as the collection route is: the org's OWNER/ADMIN
 * while acting in it, or a platform admin. No owner check here, on purpose —
 * ending access is always safe, so anyone who may see the grant may end it.
 * A grant that has already ended answers 200 with `revoked: false` and is not
 * written; a grant id that is not this org's is a 404.
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { supportGrantParamsSchema } from '@/lib/validations/tenancy';
import { resolveOrgResource } from '@/lib/tenancy/lifecycle';
import { revokeSupportGrant } from '@/lib/tenancy/support-grants';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';
import { getRouteLogger } from '@/lib/api/context';

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) =>
    resolveOrgResource(await context?.params),
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the org the URL names; the revocation is keyed on that resolved org id and the grant id together, so another org’s grant is not found.',
  },
} as const;

export const DELETE = withAuth<{ id: string; grantId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);

    if (isApiKeySession(session)) {
      log.warn('Rejected API-key attempt to revoke a support grant', { userId: session.user.id });
      throw new ForbiddenError('Revoking support access requires a browser session');
    }

    const { id, grantId } = validateQueryParams(
      new URLSearchParams(await params),
      supportGrantParamsSchema
    );

    const { grant, revoked } = await revokeSupportGrant(id, grantId, {
      userId: session.user.id,
    });

    if (revoked) {
      const org = await prisma.org.findUnique({ where: { id }, select: { name: true } });
      logAdminAction({
        userId: session.user.id,
        action: 'support_grant.revoke',
        entityType: 'support_grant',
        entityId: grantId,
        entityName: org?.name ?? null,
        metadata: { orgId: id },
        clientIp: getClientIP(request),
      });
      log.info('Support grant revoked', { orgId: id, grantId, actorUserId: session.user.id });
    }

    return successResponse({ grant, revoked });
  },
  RESOURCE
);
