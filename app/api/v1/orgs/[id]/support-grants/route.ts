/**
 * An org's support grants (§121 t-823)
 *
 * GET  /api/v1/orgs/[id]/support-grants — the open grant, if any, and the
 *      history, newest first.
 * POST /api/v1/orgs/[id]/support-grants — grant vendor support access:
 *      `{ reason, level?, durationHours? }`. Replaces the open grant if there
 *      is one.
 *
 * Admission is the policy's, through the org `resource` the members routes
 * hand the guard (see `members/route.ts` for whom the org arm admits): the
 * org's OWNER/ADMIN while acting in it, and a platform admin from anywhere.
 * So a platform admin can read which grants an org has given — the vendor
 * needs to know where it may go — but cannot give one: granting needs the
 * caller's own OWNER role in this org, which `grantSupportAccess` checks off
 * the principal and never off platform standing
 * (`lib/tenancy/support-grants.ts`). The vendor granting itself access is
 * what the grant exists to prevent.
 *
 * A browser session only, as on the members routes: consent is a person's
 * act, and no key scope means "speak for the org".
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { createSupportGrantSchema, orgIdParamSchema } from '@/lib/validations/tenancy';
import { resolveOrgResource } from '@/lib/tenancy/lifecycle';
import {
  grantSupportAccess,
  listSupportGrants,
  supportGrantActorOf,
} from '@/lib/tenancy/support-grants';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';
import { getRouteLogger } from '@/lib/api/context';

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) =>
    resolveOrgResource(await context?.params),
  // Ownership: the policy decided about the org the resolver named, and the
  // handlers read and write that org's grants only.
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the org the URL names; grants are listed and written for that resolved org id only.',
  },
} as const;

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  if (isApiKeySession(session)) {
    const log = await getRouteLogger(request);
    log.warn('Rejected API-key attempt to read support grants', { userId: session.user.id });
    throw new ForbiddenError('Reading support grants requires a browser session');
  }

  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const grants = await listSupportGrants(id);

  return successResponse({ orgId: id, grants });
}, RESOURCE);

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to grant support access', { userId: session.user.id });
    throw new ForbiddenError('Granting support access requires a browser session');
  }

  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, createSupportGrantSchema);

  const { grant, replacedGrantIds } = await grantSupportAccess(
    id,
    body,
    supportGrantActorOf(session)
  );

  const org = await prisma.org.findUnique({ where: { id }, select: { name: true } });
  const clientIp = getClientIP(request);
  for (const replacedGrantId of replacedGrantIds) {
    logAdminAction({
      userId: session.user.id,
      action: 'support_grant.replace',
      entityType: 'support_grant',
      entityId: replacedGrantId,
      entityName: org?.name ?? null,
      metadata: { orgId: id, replacedBy: grant.id },
      clientIp,
    });
  }
  logAdminAction({
    userId: session.user.id,
    action: 'support_grant.create',
    entityType: 'support_grant',
    entityId: grant.id,
    entityName: org?.name ?? null,
    metadata: {
      orgId: id,
      level: grant.level,
      reason: grant.reason,
      expiresAt: grant.expiresAt.toISOString(),
    },
    clientIp,
  });

  log.info('Support grant created', {
    orgId: id,
    grantId: grant.id,
    replacedGrantIds,
    actorUserId: session.user.id,
  });

  return successResponse({ grant, replacedGrantIds }, undefined, { status: 201 });
}, RESOURCE);
