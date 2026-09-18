/**
 * An org's data, for the customer being offboarded (§106 t-672)
 *
 * GET /api/v1/admin/orgs/[id]/export — the bundle `exportOrgData` builds:
 * the org row, its roster, its pending invitations, and the identity of
 * the credentials it holds. Served as a download, never cached, under the
 * same per-admin sub-cap as the subject export — an export walks every
 * source in the manifest, so it is the one expensive read on this surface.
 *
 * Platform-only: the vendor answers "give us our data" on the customer's
 * behalf, the way `users/[id]/export` answers a subject's request. An org
 * OWNER's own self-service export is §111's page to add on top of the same
 * service.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { orgIdParamSchema } from '@/lib/validations/tenancy';
import { exportOrgData, OrgNotFoundError } from '@/lib/privacy/export-org';
import { getRouteLogger } from '@/lib/api/context';
import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

export const GET = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

    // Per-flow sub-cap on top of the section tier, keyed on the acting admin
    // — the subject export's own key, since it is the same class of work.
    const rl = exportLimiter.check(`export:org:${session.user.id}`);
    if (!rl.success) return createRateLimitResponse(rl);

    const log = await getRouteLogger(request);
    log.info('Generating org data export', { orgId: id });

    try {
      const bundle = await exportOrgData({ orgId: id, actorUserId: session.user.id });

      return successResponse(bundle, undefined, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="org-data-${id}.json"`,
        },
      });
    } catch (error) {
      if (error instanceof OrgNotFoundError) {
        throw new NotFoundError('Organisation not found');
      }
      throw error;
    }
  },
  {
    // Ownership: no ownership decision — a vendor surface, platform admin only. See RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'nothing',
      because:
        'The vendor exporting one org on the customer’s request: the bundle is the org’s, not any user’s, and the guard already limits this to platform admins.',
    },
  }
);
