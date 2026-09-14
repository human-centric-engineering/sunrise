/**
 * Admin Orchestration — Single Experiment (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/experiments/:id
 * PATCH  /api/v1/admin/orchestration/experiments/:id
 * DELETE /api/v1/admin/orchestration/experiments/:id
 *
 * Authentication: Admin role required.
 *
 * Ownership: owner-scoped on `createdBy`, matching the rest of the family — a
 * cross-user read, edit or delete is a 404, so the existence of another admin's
 * experiment never leaks. See the header of `../route.ts` for why the family is
 * owner-scoped rather than admin-global (#741), and `experiment-access.ts` for
 * why an experiment nobody owns is still reachable here (t-678).
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import {
  experimentVisibilityWhere,
  experimentAccessBasis,
  logExperimentAccess,
} from '@/lib/orchestration/access/experiment-access';

type Params = { id: string };

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['completed'],
  running: ['completed'],
  completed: [],
};

const updateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    status: z.enum(['draft', 'running', 'completed']).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.status !== undefined, {
    message: 'At least one field must be provided',
  });

export const GET = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const { id } = await params;
    const log = await getRouteLogger(request);

    const experiment = await prisma.aiExperiment.findFirst({
      where: { AND: [experimentVisibilityWhere(session), { id }] },
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
    if (!experiment) throw new NotFoundError('Experiment not found');

    // Narrowing for the type, not re-checking the boundary: the `where` above
    // admits only 'owner' and 'orphan' rows, so this cannot be null. It used to
    // fall back to `?? 'orphan'`, which filed a null — the exact state a
    // widening regression produces — as an ordinary orphan read, in the log an
    // operator would use to notice that regression. A 404 keeps the signal.
    const basis = experimentAccessBasis(experiment, session.user.id);
    if (!basis) throw new NotFoundError('Experiment not found');

    // The row reached the caller, so the policy already said yes — this only
    // names WHICH of the two reasons it was. Reading a row whose creator was
    // erased is worth a record; reading your own is not.
    logExperimentAccess({
      adminUserId: session.user.id,
      experimentId: id,
      experimentName: experiment.name,
      basis,
      action: 'experiment.view',
      record: 'non-owner-only',
      clientIp: getClientIP(request),
    });

    log.info('Experiment fetched', { experimentId: id });
    return successResponse(experiment);
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        "Reads one experiment the caller may see — theirs, or one nobody owns when canRead permits an unattributed read. Never another subject's.",
    },
  }
);

export const PATCH = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const { id } = await params;
    const log = await getRouteLogger(request);
    const body = await validateRequestBody(request, updateSchema);

    const existing = await prisma.aiExperiment.findFirst({
      where: { AND: [experimentVisibilityWhere(session), { id }] },
    });
    if (!existing) throw new NotFoundError('Experiment not found');

    // Narrowing for the type, not re-checking the boundary: the `where` above
    // admits only 'owner' and 'orphan' rows, so this cannot be null. It used to
    // fall back to `?? 'orphan'`, which filed a null — the exact state a
    // widening regression produces — as an ordinary orphan read, in the log an
    // operator would use to notice that regression. A 404 keeps the signal.
    const basis = experimentAccessBasis(existing, session.user.id);
    if (!basis) throw new NotFoundError('Experiment not found');

    if (body.status !== undefined) {
      const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw new ValidationError(
          `Cannot transition from '${existing.status}' to '${body.status}'`
        );
      }
    }

    // Pinned to the ownership the read above saw, not just to `id`. An orphan
    // can now be claimed, so `createdBy` has a null -> someone transition it did
    // not have before: without this, an admin could edit a row another admin
    // claimed in the window, which a re-read would have 404'd. A miss throws
    // P2025, which the shared handler renders as 404 — the honest answer, since
    // the row is no longer one this caller may write.
    const experiment = await prisma.aiExperiment.update({
      where: { id, createdBy: existing.createdBy },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
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

    // `'always'`, not `'non-owner-only'`: every mutation of an experiment wrote
    // an audit row before this helper existed, including the owner's own, and
    // narrowing that to match `logDatasetAccess` would delete rows an operator
    // can read today. See `ExperimentAuditRule`.
    logExperimentAccess({
      adminUserId: session.user.id,
      experimentId: id,
      experimentName: experiment.name,
      basis,
      action: 'experiment.update',
      record: 'always',
      extra: { changedKeys: Object.keys(body) },
      clientIp: clientIP,
    });

    log.info('Experiment updated', { experimentId: id });
    return successResponse(experiment);
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        "The row is fetched under the caller's visible clause — theirs, or unowned where the policy allows — before it is updated; the update addresses it by its already-checked unique id.",
    },
  }
);

export const DELETE = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const { id } = await params;
    const log = await getRouteLogger(request);

    const existing = await prisma.aiExperiment.findFirst({
      where: { AND: [experimentVisibilityWhere(session), { id }] },
    });
    if (!existing) throw new NotFoundError('Experiment not found');

    // Narrowing for the type, not re-checking the boundary: the `where` above
    // admits only 'owner' and 'orphan' rows, so this cannot be null. It used to
    // fall back to `?? 'orphan'`, which filed a null — the exact state a
    // widening regression produces — as an ordinary orphan read, in the log an
    // operator would use to notice that regression. A 404 keeps the signal.
    const basis = experimentAccessBasis(existing, session.user.id);
    if (!basis) throw new NotFoundError('Experiment not found');

    if (existing.status === 'running') {
      throw new ValidationError('Cannot delete a running experiment — stop it first');
    }

    // Pinned to the ownership the read above saw — see the PATCH handler.
    await prisma.aiExperiment.delete({ where: { id, createdBy: existing.createdBy } });

    logExperimentAccess({
      adminUserId: session.user.id,
      experimentId: id,
      experimentName: existing.name,
      basis,
      action: 'experiment.delete',
      record: 'always',
      clientIp: clientIP,
    });

    log.info('Experiment deleted', { experimentId: id });
    return successResponse({ deleted: true });
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        "The row is fetched under the caller's visible clause — theirs, or unowned where the policy allows — before it is deleted; the delete addresses it by its already-checked unique id.",
    },
  }
);
