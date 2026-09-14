/**
 * Admin Orchestration — Experiment compare data.
 *
 * GET /api/v1/admin/orchestration/experiments/:id/compare
 *   Returns the experiment's variants joined to each variant's
 *   AiEvaluationRun summary, projected down to the shape the compare
 *   view consumes: per-variant rawScores and means, plus a sorted
 *   union of metric slugs across all variants.
 *
 * Only the creator may compare; the route returns 404 on
 * cross-user access so the existence of an experiment isn't leaked.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import {
  experimentVisibilityWhere,
  experimentAccessBasis,
  logExperimentAccess,
} from '@/lib/orchestration/access/experiment-access';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import type { PairwiseVerdictSummary } from '@/types/orchestration';

type Params = { id: string };

interface RawScores {
  [graderSlug: string]: number[];
}

export interface VariantCompareRow {
  variantId: string;
  label: string;
  evaluationRunId: string | null;
  runStatus: string | null;
  rawScores: RawScores;
  meanByMetric: Record<string, number | null>;
}

export interface ExperimentCompareResponse {
  experimentName: string;
  variants: VariantCompareRow[];
  metricSlugs: string[];
  /**
   * Phase 3.5a: number of dataset cases on the experiment's shared
   * dataset. Used by the compare view to gate the "Run verdict" action
   * behind the 100-case cap.
   */
  caseCount: number | null;
  /**
   * Phase 3.5a: stored pairwise verdict tally (or null when none has
   * been computed yet). Written by `POST /experiments/:id/verdicts`.
   */
  pairwiseVerdict: PairwiseVerdictSummary | null;
}

function readRawScores(summary: Record<string, unknown> | null): RawScores {
  if (!summary || typeof summary !== 'object') return {};
  const raw = (summary as { rawScores?: unknown }).rawScores;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: RawScores = {};
  for (const [slug, scores] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(scores)) {
      const numeric = scores.filter(
        (s): s is number => typeof s === 'number' && Number.isFinite(s)
      );
      if (numeric.length > 0) result[slug] = numeric;
    }
  }
  return result;
}

function meanOrNull(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export const GET = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id } = await params;

    // Ownership in the `where`, not a post-fetch comparison: the boundary is
    // then visible at the query, which is where every other route in this family
    // spells it. Cross-user 404 so a foreign experiment's existence never leaks.
    const experiment = await prisma.aiExperiment.findFirst({
      where: { AND: [experimentVisibilityWhere(session), { id }] },
      include: {
        variants: {
          include: {
            evaluationRun: {
              select: { id: true, status: true, summary: true },
            },
          },
        },
        // `userId` gates `caseCount` below — a fact about a dataset row,
        // not about this experiment.
        dataset: { select: { caseCount: true, userId: true } },
        creator: { select: { id: true } },
      },
    });
    if (!experiment) {
      throw new NotFoundError(`Experiment ${id} not found`);
    }

    // Narrowing for the type, not re-checking the boundary: the `where` above
    // admits only 'owner' and 'orphan' rows, so this cannot be null. It used to
    // fall back to `?? 'orphan'`, which filed a null — the exact state a
    // widening regression produces — as an ordinary orphan read, in the log an
    // operator would use to notice that regression. A 404 keeps the signal.
    const basis = experimentAccessBasis(experiment, session.user.id);
    if (!basis) throw new NotFoundError(`Experiment ${id} not found`);

    // The second read of one experiment's contents, so the same rule as the
    // detail route: a row whose creator was erased is worth a record, your own
    // is not. Leaving it out would let an admin read an orphan's scores through
    // this route while `GET /:id` left a trail for the same rows.
    // Defence in depth on the bound dataset, the third of three in this family
    // and now spelled the same way as the other two: refuse, naming the
    // dataset.
    //
    // Round 3 of this PR gated the `caseCount` FIELD instead, reasoning that
    // this route's job is showing the caller their own variants' scores and
    // 404ing would deny them their own data to withhold one integer. That
    // rested on a claim about the consumer — "the compare view already renders
    // null" — which was asserted without reading the view and is wrong:
    // `pairwise-verdict-card.tsx` sets `noDataset = caseCount === null` and
    // tells the operator "This experiment has no dataset". Withholding the
    // count made the page state something false about an experiment that does
    // have one. A refusal is honest, matches `run` and `verdicts`, and leaves
    // no bespoke case whose UI contract has to be kept in step.
    //
    // Unreachable today by the same margin as its two siblings: `POST
    // /experiments` is the only path that binds a dataset and it enforces
    // `datasetVisibilityWhere`, and the update schema refuses `datasetId`.
    const boundDatasetOwner = experiment.dataset?.userId ?? null;
    const mayReadBoundDataset =
      // `!experiment.dataset` rather than `=== null`: the field is absent on a
      // legacy experiment, and "nothing bound" is not "bound but not yours".
      !experiment.dataset ||
      boundDatasetOwner === session.user.id ||
      (boundDatasetOwner === null && session.unattributedReads.dataset);
    if (!mayReadBoundDataset) throw new NotFoundError(`Experiment ${id} dataset not found`);

    logExperimentAccess({
      adminUserId: session.user.id,
      experimentId: id,
      experimentName: experiment.name,
      basis,
      action: 'experiment.compare_view',
      record: 'non-owner-only',
      clientIp: getClientIP(request),
    });

    const allMetricSlugs = new Set<string>();
    const variants: VariantCompareRow[] = experiment.variants.map((v) => {
      const summary = (v.evaluationRun?.summary as Record<string, unknown> | null) ?? null;
      const rawScores = readRawScores(summary);
      const meanByMetric: Record<string, number | null> = {};
      const stats = (summary?.stats as Record<string, { mean?: number | null }> | undefined) ?? {};
      for (const [slug, raw] of Object.entries(rawScores)) {
        allMetricSlugs.add(slug);
        meanByMetric[slug] =
          typeof stats[slug]?.mean === 'number' ? (stats[slug]?.mean ?? null) : meanOrNull(raw);
      }
      return {
        variantId: v.id,
        label: v.label,
        evaluationRunId: v.evaluationRunId,
        runStatus: v.evaluationRun?.status ?? null,
        rawScores,
        meanByMetric,
      };
    });

    log.info('Experiment compare fetched', {
      experimentId: id,
      variantCount: variants.length,
      metricCount: allMetricSlugs.size,
    });

    const payload: ExperimentCompareResponse = {
      experimentName: experiment.name,
      variants,
      metricSlugs: Array.from(allMetricSlugs).sort(),
      caseCount: experiment.dataset?.caseCount ?? null,
      pairwiseVerdict: (experiment.pairwiseVerdict as PairwiseVerdictSummary | null) ?? null,
    };
    return successResponse(payload);
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        "Reads one experiment and its variants under the caller's visible clause — theirs, or unowned where the policy allows — and nothing else.",
    },
  }
);
