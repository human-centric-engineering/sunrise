/**
 * One member's named-tier grant, for the people who administer the org
 * (t-1123)
 *
 * PUT /api/v1/orgs/[id]/members/[userId]/tiers — `{ tiers }`: the member's
 *     grant lists exactly these named admin tiers. `[]` removes it.
 *
 * A grant opens part of the console to a MEMBER without making them an
 * ADMIN: the tiers an app registered with `registerAdminTier()` and lets an
 * org admin grant. The rules are `setMemberTiers` in
 * `lib/tenancy/lifecycle.ts`: refused on the install org, for someone not a
 * member (404), beside any role but MEMBER (409 `GRANT_NEEDS_MEMBER`), and
 * for a tier that cannot be granted (400 `TIER_NOT_GRANTABLE`, naming it).
 *
 * Admission is the policy's, through the same org `resource` the sibling
 * members routes hand the guard: the org's OWNER or ADMIN acting in it, or a
 * platform admin. An ADMIN may grant tiers to anyone, as they may invite:
 * every named tier is narrower than their own role. A browser session only,
 * as for every write to the roster.
 */

import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { orgMemberParamsSchema, setOrgMemberTiersSchema } from '@/lib/validations/tenancy';
import { resolveOrgResource, setMemberTiers } from '@/lib/tenancy/lifecycle';
import { getRouteLogger } from '@/lib/api/context';

type Params = { id: string; userId: string };

export const PUT = withAuth<Params>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    if (isApiKeySession(session)) {
      log.warn('Rejected API-key attempt to set an org member’s tiers', {
        userId: session.user.id,
      });
      throw new ForbiddenError('Managing members requires a browser session');
    }

    const { id, userId } = validateQueryParams(
      new URLSearchParams(await params),
      orgMemberParamsSchema
    );
    const { tiers } = await validateRequestBody(request, setOrgMemberTiersSchema);

    const record = await setMemberTiers(id, userId, tiers);

    log.info('Org member tiers set', {
      orgId: id,
      memberUserId: userId,
      tiers: record.tiers,
      actorUserId: session.user.id,
    });

    return successResponse(record);
  },
  {
    resource: async (_request: unknown, context?: { params: Promise<Params> }) =>
      resolveOrgResource(await context?.params),
    // Ownership: the policy decided about the org the resolver named, and the
    // grant written is keyed on that resolved org id and the URL's user id.
    ownership: {
      decidedBy: 'resource',
      because:
        'The policy admitted the caller to the org the URL names; the grant written is on the membership keyed by that resolved org id and the URL’s user id.',
    },
  }
);
