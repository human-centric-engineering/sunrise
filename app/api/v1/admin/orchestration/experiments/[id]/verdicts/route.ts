/**
 * Admin Orchestration — Pairwise verdicts on an experiment (Phase 3.5a).
 *
 * POST /api/v1/admin/orchestration/experiments/:id/verdicts
 *
 * Body: `{ judgeAgentSlug, variantAId, variantBId }`. Loads both
 * variants' per-case `AiEvaluationCaseResult` rows, joins them by
 * `casePosition`, and invokes the `pairwise_judge_agent` grader once
 * per pair. Result (tally + per-case verdicts) is persisted as JSON
 * on `AiExperiment.pairwiseVerdict` and returned inline so the
 * compare page can re-render without a follow-up GET.
 *
 * Capped at 100 paired cases — beyond that the latency + judge spend
 * outweighs the value, and the operator should use a smaller dataset.
 * Rerunning overwrites the prior tally.
 *
 * Authentication: Admin role required + experiment ownership (cross-user
 * access returns 404 to avoid leaking experiment existence).
 *
 * Sub-cap: 5/min/session-user via `pairwiseVerdictLimiter` — each call
 * drives up to 100 judge LLM invocations, so the limit is tighter than
 * the section tier's 120/min.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { visibleExperimentClause } from '@/lib/orchestration/experiments/visible-scope';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { runPairwiseVerdictSchema } from '@/lib/validations/orchestration-evaluations';
import { pairwiseVerdictLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { pairwiseJudgeAgentGrader } from '@/lib/orchestration/evaluations/graders/pairwise/judge-agent';
import type { PairwiseVerdictCase, PairwiseVerdictSummary } from '@/types/orchestration';

type Params = { id: string };

const MAX_CASES_FOR_SYNC = 100;

export const POST = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id } = await params;

    const rl = pairwiseVerdictLimiter.check(session.user.id);
    if (!rl.success) {
      log.warn('Pairwise verdict rate limit exceeded', {
        userId: session.user.id,
        experimentId: id,
        remaining: rl.remaining,
        reset: rl.reset,
      });
      return createRateLimitResponse(rl);
    }

    const body = await validateRequestBody(request, runPairwiseVerdictSchema);

    // Ownership in the `where`, not a post-fetch comparison — same spelling as
    // every other route in this family. Cross-user 404 so a foreign experiment's
    // existence never leaks.
    const experiment = await prisma.aiExperiment.findFirst({
      where: { AND: [await visibleExperimentClause(session), { id }] },
      select: {
        id: true,
        // Not for the ownership test — the `where` above settles that — but so
        // the write at the end can pin itself to the owner this read saw.
        createdBy: true,
        datasetId: true,
        variants: {
          select: { id: true, label: true, evaluationRunId: true },
        },
        dataset: { select: { caseCount: true } },
      },
    });
    if (!experiment) {
      throw new NotFoundError(`Experiment ${id} not found`);
    }

    const variantA = experiment.variants.find((v) => v.id === body.variantAId);
    const variantB = experiment.variants.find((v) => v.id === body.variantBId);
    if (!variantA || !variantB) {
      throw new ValidationError('Both variantAId and variantBId must belong to this experiment');
    }
    if (!variantA.evaluationRunId || !variantB.evaluationRunId) {
      throw new ValidationError(
        'Both variants must have a completed AiEvaluationRun before verdicts can be computed'
      );
    }

    if (!experiment.dataset) {
      throw new ValidationError(
        'Experiment has no dataset — verdicts need dataset-driven variants'
      );
    }
    if (experiment.dataset.caseCount > MAX_CASES_FOR_SYNC) {
      throw new ConflictError(
        `Pairwise verdicts cap at ${MAX_CASES_FOR_SYNC} cases — this dataset has ${experiment.dataset.caseCount}. Use a smaller dataset.`
      );
    }

    const judgeAgent = await prisma.aiAgent.findUnique({
      where: { slug: body.judgeAgentSlug },
      select: { id: true, kind: true, isActive: true },
    });
    if (!judgeAgent) {
      throw new ValidationError(`Judge agent "${body.judgeAgentSlug}" not found`);
    }
    if (judgeAgent.kind !== 'judge' || !judgeAgent.isActive) {
      throw new ValidationError(`Agent "${body.judgeAgentSlug}" is not an active judge agent`);
    }

    const [resultsA, resultsB] = await Promise.all([
      prisma.aiEvaluationCaseResult.findMany({
        where: { runId: variantA.evaluationRunId },
        select: {
          casePosition: true,
          subjectOutput: true,
          datasetCase: {
            select: { input: true, expectedOutput: true },
          },
        },
      }),
      prisma.aiEvaluationCaseResult.findMany({
        where: { runId: variantB.evaluationRunId },
        select: {
          casePosition: true,
          subjectOutput: true,
        },
      }),
    ]);

    const bByPosition = new Map<number, string>();
    for (const r of resultsB) bByPosition.set(r.casePosition, r.subjectOutput);

    // Pair up by position. Skip positions one side is missing — that case is
    // recorded as a failure with a clarifying error string.
    const pairs: Array<{
      position: number;
      userInput: string;
      expectedOutput?: string;
      outputA: string;
      outputB: string;
    }> = [];
    const missing: PairwiseVerdictCase[] = [];

    for (const r of resultsA) {
      const outputB = bByPosition.get(r.casePosition);
      const userInput =
        typeof r.datasetCase.input === 'string'
          ? r.datasetCase.input
          : JSON.stringify(r.datasetCase.input);
      if (outputB === undefined) {
        missing.push({
          casePosition: r.casePosition,
          verdict: 'tie',
          reasoning: 'variant B has no result for this case',
          error: 'missing_variant_b_result',
        });
        continue;
      }
      pairs.push({
        position: r.casePosition,
        userInput,
        ...(r.datasetCase.expectedOutput ? { expectedOutput: r.datasetCase.expectedOutput } : {}),
        outputA: r.subjectOutput,
        outputB,
      });
    }

    // Also catch positions present in B but missing from A.
    const aPositions = new Set(resultsA.map((r) => r.casePosition));
    for (const r of resultsB) {
      if (!aPositions.has(r.casePosition)) {
        missing.push({
          casePosition: r.casePosition,
          verdict: 'tie',
          reasoning: 'variant A has no result for this case',
          error: 'missing_variant_a_result',
        });
      }
    }

    const perCase: PairwiseVerdictCase[] = [];
    const counts = { A: 0, B: 0, tie: 0 };
    let casesScored = 0;
    let casesFailed = missing.length;

    for (const pair of pairs) {
      const judgeResult = await pairwiseJudgeAgentGrader.grade({
        userInput: pair.userInput,
        outputA: pair.outputA,
        outputB: pair.outputB,
        ...(pair.expectedOutput ? { expectedOutput: pair.expectedOutput } : {}),
        judge: { userId: session.user.id },
        config: { judgeAgentSlug: body.judgeAgentSlug },
      });
      // Grader signals failure by prefixing reasoning with its slug; verdict
      // is forced to 'tie' in that path. Treat as a failed pair so the tally
      // isn't polluted by infrastructure noise.
      const isError = judgeResult.reasoning.startsWith('pairwise_judge_agent');
      if (isError) {
        casesFailed += 1;
        perCase.push({
          casePosition: pair.position,
          verdict: judgeResult.verdict,
          reasoning: judgeResult.reasoning,
          error: 'judge_failed',
        });
      } else {
        casesScored += 1;
        counts[judgeResult.verdict] += 1;
        perCase.push({
          casePosition: pair.position,
          verdict: judgeResult.verdict,
          reasoning: judgeResult.reasoning,
        });
      }
    }

    const summary: PairwiseVerdictSummary = {
      judgeAgentSlug: body.judgeAgentSlug,
      variantAId: variantA.id,
      variantBId: variantB.id,
      computedAt: new Date().toISOString(),
      casesScored,
      casesFailed,
      counts,
      perCase: [...perCase, ...missing].sort((a, b) => a.casePosition - b.casePosition),
    };

    // Pinned to the ownership the read at the top of this handler saw. The
    // judging above is slow, so this window is the widest in the family; an
    // orphan claimed meanwhile must not have a verdict written onto it by the
    // admin who no longer holds it.
    await prisma.aiExperiment.update({
      where: { id, createdBy: experiment.createdBy },
      data: { pairwiseVerdict: summary as unknown as Prisma.InputJsonValue },
    });

    log.info('Pairwise verdict computed', {
      experimentId: id,
      judgeAgentSlug: body.judgeAgentSlug,
      variantAId: variantA.id,
      variantBId: variantB.id,
      casesScored,
      casesFailed,
      counts,
    });

    return successResponse(summary);
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        "Reads and writes one experiment under the caller's visible clause — theirs, or unowned where the policy allows — and reaches case results only through that experiment's own variant run ids. The judge agent it invokes is an AiAgent, which is admin-global by design and carries nobody's rows.",
    },
  }
);
