/**
 * Admin Orchestration — Claim an ownerless Experiment
 *
 * POST /api/v1/admin/orchestration/experiments/:id/claim
 *
 * Authentication: Admin role required.
 *
 * An experiment whose creator was erased under Art. 17 is retained with a null
 * `createdBy` — deliberately, so the work survives the person. Every other route
 * in this family will show it to a caller the policy lets read unowned rows, but
 * showing is not enough: until somebody owns it, it sits outside the ownership
 * rules the rest of the model runs on, and it can never become normal again.
 *
 * This is how it becomes normal again. Claiming stamps the caller as the owner,
 * after which the experiment behaves exactly like one they created (t-678).
 *
 * **Only a row nobody owns can be claimed.** Taking one that already has an
 * owner would be theft dressed as an operator action, and it is refused with the
 * same 404 the rest of the family uses for a foreign row — so this route cannot
 * be used to probe whether someone else's experiment exists.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { ConflictError, NotFoundError } from '@/lib/api/errors';
import {
  experimentVisibilityWhere,
  experimentAccessBasis,
  logExperimentAccess,
} from '@/lib/orchestration/access/experiment-access';

type Params = { id: string };

export const POST = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);
    const { id } = await params;
    const log = await getRouteLogger(request);

    // Read under the same visible clause as every other route, so a row this
    // caller could not have seen is not one they can learn about by claiming it.
    const existing = await prisma.aiExperiment.findFirst({
      where: { AND: [experimentVisibilityWhere(session), { id }] },
      select: { id: true, name: true, createdBy: true },
    });
    if (!existing) throw new NotFoundError('Experiment not found');

    // Two refusals, in this order, and the order is the point. A null basis
    // means the row was not admitted by the clause above — the state a widening
    // regression produces — and folding it into the `!== 'orphan'` test below
    // would answer a foreign row with a 409 that CONFIRMS it exists, which is
    // exactly what this family's 404 posture prevents. Every other handler in
    // the PR narrows this way; this one kept the old `isUnowned` shape and was
    // the last to.
    const basis = experimentAccessBasis(existing, session.user.id);
    if (!basis) throw new NotFoundError('Experiment not found');

    if (basis !== 'orphan') {
      // Now reachable only when the row is the caller's own, so saying so leaks
      // nothing.
      throw new ConflictError('Experiment already has an owner');
    }

    // `updateMany` with the null guard, not `update` by id: two admins claiming
    // the same orphan at once must not both succeed, and the second one's write
    // matching zero rows is what makes the race resolve rather than silently
    // overwrite the first claim.
    const claimed = await prisma.aiExperiment.updateMany({
      where: { id, createdBy: null },
      data: { createdBy: session.user.id },
    });
    if (claimed.count === 0) {
      throw new ConflictError('Experiment was claimed by another admin');
    }

    const experiment = await prisma.aiExperiment.findUniqueOrThrow({
      where: { id },
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        variants: {
          include: {
            evaluationSession: { select: { id: true, status: true, completedAt: true } },
          },
        },
        creator: { select: { id: true, name: true } },
      },
    });

    // The basis is the state BEFORE the claim — `'orphan'`, checked above and
    // re-checked by the null guard on the write. Reading it off `experiment`
    // would say `'owner'`, which is true a millisecond later and useless as a
    // record of why this admin was allowed to take it.
    logExperimentAccess({
      adminUserId: session.user.id,
      experimentId: id,
      experimentName: experiment.name,
      basis: 'orphan',
      action: 'experiment.claim',
      record: 'always',
      extra: { previousOwner: null },
      clientIp: clientIP,
    });

    log.info('Ownerless experiment claimed', { experimentId: id });
    return successResponse(experiment);
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        'Reads under the caller’s visible clause and writes only where createdBy IS NULL, so it can take a row nobody owns and never one belonging to another subject.',
    },
  }
);
