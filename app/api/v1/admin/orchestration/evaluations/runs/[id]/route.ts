/**
 * Admin Orchestration — Single evaluation run (read).
 *
 * GET /api/v1/admin/orchestration/evaluations/runs/:id
 *   Detail + summary + recent progress. The UI polls this every 3s
 *   while status='running' so per-case results land incrementally.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { datasetVisibilityWhere } from '@/lib/orchestration/access/dataset-access';
import { computeGateVerdict } from '@/lib/orchestration/evaluations/gate';
import type { GateConfig } from '@/lib/validations/orchestration-evaluations';

export const GET = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const idParsed = cuidSchema.safeParse(rawId);
    if (!idParsed.success) {
      throw new ValidationError('Invalid run id', { id: ['Must be a valid CUID'] });
    }
    const id = idParsed.data;
    const run = await prisma.aiEvaluationRun.findFirst({
      where: { id, userId: session.user.id },
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        workflow: { select: { id: true, name: true, slug: true } },
        _count: { select: { results: true } },
      },
    });
    if (!run) throw new NotFoundError(`Run ${id} not found`);

    // The run's dataset, read on its own: it can change hands after the run (an
    // orphan another admin claims). Included, the owner layer (§115) would
    // refuse the whole read for that one row; read here, it is `null` and the
    // view says so, while the caller keeps their own run.
    const dataset = await prisma.aiDataset.findFirst({
      where: { AND: [datasetVisibilityWhere(session), { id: run.datasetId }] },
      select: { id: true, name: true, caseCount: true, contentHash: true },
    });

    // Phase 4: compute the gate verdict on the fly when both `gateConfig`
    // and a populated `summary` exist. CI callers read `data.gate.passed`
    // directly to exit 0 / non-zero.
    const gate = computeGateVerdict(
      run.gateConfig as GateConfig | null,
      run.summary as {
        stats?: Record<string, { mean?: number | null; passRate?: number | null }>;
      } | null
    );

    log.info('Loaded run', { runId: id, status: run.status, gatePassed: gate?.passed });
    return successResponse({ ...run, dataset, gate });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'self',
      because:
        "Scoped to the evaluation sessions, runs and datasets this caller owns — and ownerless datasets where the policy permits them — keyed on the caller's id. Never another member's.",
    },
  }
);
