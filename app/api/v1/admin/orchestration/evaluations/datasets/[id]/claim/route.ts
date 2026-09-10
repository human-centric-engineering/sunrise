/**
 * Admin Orchestration — Claim an ownerless dataset
 *
 * POST /api/v1/admin/orchestration/evaluations/datasets/:id/claim
 *
 * Authentication: Admin role required.
 *
 * A dataset whose creator was erased under Art. 17 is retained with a null
 * `userId` — deliberately, so the test cases survive the person. Every other
 * dataset route will show it to a caller the policy lets read unowned rows,
 * but showing is not enough: until somebody owns it, it sits outside the
 * ownership rules the rest of the model runs on and can never become normal
 * again (t-679).
 *
 * This is how it becomes normal again. Claiming stamps the caller as `userId`,
 * after which the dataset behaves exactly like one they created.
 *
 * **Only a row nobody owns can be claimed.** Taking one that already has an
 * owner would be theft dressed as an operator action, and it is refused with
 * the same 404 the rest of the family uses for a foreign row — so this route
 * cannot be used to probe whether another admin's dataset exists.
 *
 * Mirrors `experiments/[id]/claim` deliberately; the two are the same act on
 * the two models that carry this shape.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { ConflictError, NotFoundError } from '@/lib/api/errors';
import { validatePathParam } from '@/lib/api/validation';
import { cuidSchema } from '@/lib/validations/common';
import {
  datasetVisibilityWhere,
  datasetAccessBasis,
  logDatasetAccess,
} from '@/lib/orchestration/access/dataset-access';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'dataset id' });

  // Read under the same visibility clause as every other route, so a row this
  // caller could not have seen is not one they can learn about by claiming it.
  const existing = await prisma.aiDataset.findFirst({
    where: { AND: [await datasetVisibilityWhere(session), { id }] },
    select: { id: true, name: true, userId: true },
  });
  if (!existing) throw new NotFoundError(`Dataset ${id} not found`);

  if (datasetAccessBasis(existing, session.user.id) !== 'orphan') {
    // Reachable only when the row is the caller's own — a third party's was
    // already a 404 above — so saying so leaks nothing.
    throw new ConflictError('Dataset already has an owner');
  }

  // `updateMany` with the null guard, not `update` by id: two admins claiming
  // the same orphan at once must not both succeed, and the second one's write
  // matching zero rows is what makes the race resolve rather than silently
  // overwrite the first claim.
  const claimed = await prisma.aiDataset.updateMany({
    where: { id, userId: null },
    data: { userId: session.user.id },
  });
  if (claimed.count === 0) {
    throw new ConflictError('Dataset was claimed by another admin');
  }

  const dataset = await prisma.aiDataset.findUniqueOrThrow({ where: { id } });

  logDatasetAccess({
    adminUserId: session.user.id,
    datasetId: id,
    datasetName: dataset.name,
    basis: 'orphan',
    action: 'dataset.claimed',
    clientIp: getClientIP(request),
  });

  log.info('Ownerless dataset claimed', { datasetId: id });
  return successResponse(dataset);
});
