/**
 * One org's approved providers (§120 t-742)
 *
 * GET /api/v1/admin/orgs/[id]/providers — the org's provider policy: the
 *     provider slugs it is approved for and the jurisdictions it is held to.
 * PUT /api/v1/admin/orgs/[id]/providers — replace it:
 *     `{ approved: string[], jurisdictions?: string[] | null }`. `[]` revokes
 *     every grant.
 *
 * At `TENANCY_MODE=multi` core permits an org only the providers named here
 * (`lib/orchestration/llm/org-provider-policy.ts`); every org but the install
 * org starts with none. The install org is unrestricted by rule, so it has no
 * set to replace and a PUT naming it is refused. At `single` the policy is
 * stored and not applied, and the response says which.
 *
 * Platform-only: providers are platform-ops configuration (design Q3), and an
 * org admin does not decide which vendors their org's data reaches. Every
 * replacement is written to the admin audit log with its before and after.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { forgetOrgProviderPolicy } from '@/lib/orchestration/llm/org-provider-policy';
import { isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import { readOrgProviderPolicy, writeOrgProviderPolicy } from '@/lib/tenancy/org-settings';
import {
  orgIdParamSchema,
  orgProviderPolicySchema,
  type OrgProviderPolicy,
} from '@/lib/validations/tenancy';

const PLATFORM_ONLY = {
  // Ownership: no ownership decision — a vendor surface, platform admin only. See RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'nothing',
    because:
      'The vendor deciding which providers one org may use: the policy is the org’s, not any user’s, and the guard already limits this to platform admins.',
  },
} as const;

/** The policy as the API reports it, with what it means on this install. */
function describe(orgId: string, policy: OrgProviderPolicy) {
  return {
    orgId,
    // The install org is open by rule; its stored slice, if any, is not read.
    unrestricted: orgId === INSTALL_ORG_ID,
    // Whether core applies the policy here at all.
    enforced: isMultiTenant(),
    approved: policy.approved,
    jurisdictions: policy.jurisdictions ?? null,
  };
}

export const GET = withAdminAuth<{ id: string }>(async (_request, _session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const org = await prisma.org.findUnique({ where: { id }, select: { settings: true } });
  if (!org) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  return successResponse(describe(id, readOrgProviderPolicy(org.settings, { orgId: id })));
}, PLATFORM_ONLY);

export const PUT = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, orgProviderPolicySchema);

  if (id === INSTALL_ORG_ID) {
    throw new OrgLifecycleError(
      'INSTALL_ORG_IMMUTABLE',
      'The install org may use every provider; it has no approved set to replace'
    );
  }

  // A slug that names no provider row is almost always a typo, and stored it
  // would approve nothing while reading as a grant. Inactive rows are
  // accepted: approving one before it is switched on is a reasonable order.
  const known = await prisma.aiProviderConfig.findMany({
    where: { slug: { in: body.approved } },
    select: { slug: true },
  });
  const knownSlugs = new Set(known.map((row) => row.slug));
  const unknownProviders = body.approved.filter((slug) => !knownSlugs.has(slug));
  if (unknownProviders.length > 0) {
    return errorResponse(`No provider has the slug ${unknownProviders.join(', ')}`, {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { unknownProviders },
    });
  }

  const written = await writeOrgProviderPolicy(id, body);
  if (!written) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  // This process at once; other processes within the policy cache's TTL.
  forgetOrgProviderPolicy(id);

  logAdminAction({
    userId: session.user.id,
    action: 'org.providers.replace',
    entityType: 'org',
    entityId: id,
    changes: { providers: { from: written.previous, to: written.stored } },
    clientIp: getClientIP(request),
  });

  log.info('Org provider policy replaced by admin', {
    orgId: id,
    approved: written.stored.approved,
    jurisdictions: written.stored.jurisdictions ?? null,
    enforced: isMultiTenant(),
    actorUserId: session.user.id,
  });

  return successResponse(describe(id, written.stored));
}, PLATFORM_ONLY);
