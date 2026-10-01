/**
 * One org's approved providers (§120 t-742)
 *
 * GET /api/v1/admin/orgs/[id]/providers — the org's provider policy: the
 *     provider slugs it is approved for and the jurisdictions it is held to.
 * PUT /api/v1/admin/orgs/[id]/providers — replace it:
 *     `{ approved: string[], jurisdictions?: string[] | null }`, naming
 *     providers by slug. `[]` revokes every grant.
 *
 * A grant is stored as the provider ROW's id, resolved from the slug here, so
 * renaming a provider keeps its grants and deleting one and re-creating its
 * slug does not hand the new row the old one's grants. Both responses report
 * each grant as `{ id, slug }`.
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
import {
  isSettingsWriteConflict,
  readOrgProviderPolicy,
  writeOrgProviderPolicy,
} from '@/lib/tenancy/org-settings';
import {
  orgIdParamSchema,
  orgProviderPolicyInputSchema,
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

/**
 * The policy as the API reports it, with what it means on this install.
 *
 * Each grant is a provider ROW id, reported with that row's current slug — or
 * `null` when the row has since been deleted, which leaves the grant inert:
 * a provider created later under the old slug is a different row.
 */
async function describe(orgId: string, policy: OrgProviderPolicy) {
  const rows = await prisma.aiProviderConfig.findMany({
    where: { id: { in: policy.approved } },
    select: { id: true, slug: true },
  });
  const slugById = new Map(rows.map((row) => [row.id, row.slug]));
  return {
    orgId,
    // The install org is open by rule; its stored slice, if any, is not read.
    unrestricted: orgId === INSTALL_ORG_ID,
    // Whether core applies the policy here at all.
    enforced: isMultiTenant(),
    approved: policy.approved.map((id) => ({ id, slug: slugById.get(id) ?? null })),
    jurisdictions: policy.jurisdictions ?? null,
  };
}

export const GET = withAdminAuth<{ id: string }>(async (_request, _session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const org = await prisma.org.findUnique({ where: { id }, select: { settings: true } });
  if (!org) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  return successResponse(await describe(id, readOrgProviderPolicy(org.settings, { orgId: id })));
}, PLATFORM_ONLY);

export const PUT = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, orgProviderPolicyInputSchema);

  if (id === INSTALL_ORG_ID) {
    throw new OrgLifecycleError(
      'INSTALL_ORG_IMMUTABLE',
      'The install org may use every provider; it has no approved set to replace'
    );
  }

  // The org first, so a missing org is a 404 whatever the body names. The
  // write re-reads it inside its transaction; this read only orders the errors.
  const org = await prisma.org.findUnique({ where: { id }, select: { id: true } });
  if (!org) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  // Slugs are what an operator names; the grant stores each row's id, which a
  // rename or a delete-and-recreate cannot move. A slug that names no row is
  // almost always a typo. Inactive rows are accepted: approving one before it
  // is switched on is a reasonable order.
  const known = await prisma.aiProviderConfig.findMany({
    where: { slug: { in: body.approved } },
    select: { id: true, slug: true },
  });
  const idBySlug = new Map(known.map((row) => [row.slug, row.id]));
  const unknownProviders = body.approved.filter((slug) => !idBySlug.has(slug));
  if (unknownProviders.length > 0) {
    return errorResponse(`No provider has the slug ${unknownProviders.join(', ')}`, {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { unknownProviders },
    });
  }
  const policy: OrgProviderPolicy = {
    approved: body.approved.map((slug) => idBySlug.get(slug) ?? ''),
    jurisdictions: body.jurisdictions,
  };

  let written: Awaited<ReturnType<typeof writeOrgProviderPolicy>>;
  try {
    written = await writeOrgProviderPolicy(id, policy);
  } catch (error) {
    if (!isSettingsWriteConflict(error)) throw error;
    // Another write to this org's settings landed between our read and ours.
    // Nothing was written; the caller re-reads and retries.
    return errorResponse(
      "Another change to this org's settings was saved at the same time; retry",
      {
        code: 'CONFLICT',
        status: 409,
      }
    );
  }
  if (!written) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  // This process at once; other processes within the policy cache's TTL.
  forgetOrgProviderPolicy(id);

  logAdminAction({
    userId: session.user.id,
    action: 'org.providers.replace',
    entityType: 'org',
    entityId: id,
    changes: { providers: { from: written.previous, to: written.stored } },
    // The ids in `changes` are what was stored; the slugs are what a reader
    // of the log recognises.
    metadata: { approvedSlugs: body.approved },
    clientIp: getClientIP(request),
  });

  log.info('Org provider policy replaced by admin', {
    orgId: id,
    approvedSlugs: body.approved,
    jurisdictions: written.stored.jurisdictions ?? null,
    enforced: isMultiTenant(),
    actorUserId: session.user.id,
  });

  return successResponse(await describe(id, written.stored));
}, PLATFORM_ONLY);
