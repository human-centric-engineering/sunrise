/**
 * /admin/orchestration/experiments/[id]/compare
 *
 * Server-rendered side-by-side comparison of every variant's
 * AiEvaluationRun summary. Loads via the `/compare` API endpoint
 * (which projects rawScores + means from the JSON summary) and hands
 * the result to the VariantCompareTable for rendering.
 *
 * Only meaningful for dataset-driven experiments (Phase 2.4 onward).
 * Legacy session-based experiments will see "no comparison data" and a
 * pointer to the run-detail page.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  PairwiseVerdictCard,
  type JudgeOption,
} from '@/components/admin/orchestration/experiments/pairwise-verdict-card';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { VariantCompareTable } from '@/components/admin/orchestration/experiments/variant-compare-table';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import type { PairwiseVerdictSummary } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Compare variants · AI Orchestration',
  description: 'Side-by-side per-metric comparison of experiment variants.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

interface VariantRow {
  variantId: string;
  label: string;
  evaluationRunId: string | null;
  runStatus: string | null;
  rawScores: Record<string, number[]>;
  meanByMetric: Record<string, number | null>;
}

interface CompareResponse {
  experimentName: string;
  variants: VariantRow[];
  metricSlugs: string[];
  caseCount: number | null;
  pairwiseVerdict: PairwiseVerdictSummary | null;
}

interface GradersResponse {
  judgeAgents: Array<{ slug: string; name: string }>;
}

/**
 * The judge picker's options, or `null` when they could not be loaded. A
 * reply without a `judgeAgents` list counts as a failed load, so it shows the
 * notice instead of taking the whole comparison down.
 */
async function loadJudges(): Promise<JudgeOption[] | null> {
  const result = await loadServerData<GradersResponse>(API.ADMIN.ORCHESTRATION.EVAL_GRADERS);
  if (!result.ok) return null;
  const reply: unknown = result.data;
  if (
    typeof reply !== 'object' ||
    reply === null ||
    !Array.isArray(Reflect.get(reply, 'judgeAgents'))
  ) {
    logger.error('Experiment compare: graders reply has no judgeAgents list', undefined, {
      path: API.ADMIN.ORCHESTRATION.EVAL_GRADERS,
    });
    return null;
  }
  return result.data.judgeAgents.map((j) => ({ slug: j.slug, name: j.name }));
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export default async function ExperimentComparePage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { id } = await params;

  // The comparison is the page: a 404 is a missing experiment, any other
  // failure reaches the error boundary. The judge list only feeds the verdict
  // picker, so its failure shows a notice above the verdict card.
  const [{ data }, judges] = await Promise.all([
    requireServerData<CompareResponse>(API.ADMIN.ORCHESTRATION.experimentCompareById(id), {
      notFound: true,
    }),
    loadJudges(),
  ]);

  const noRunsYet = data.variants.every((v) => v.evaluationRunId === null);
  // Terminal statuses are listed, not in-flight ones, so an unrecognised status
  // errs towards showing the "still running" notice.
  const someRunsStillQueued = data.variants.some(
    (v) => v.evaluationRunId !== null && !TERMINAL_RUN_STATUSES.has(v.runStatus ?? '')
  );
  const someRunsEndedWithoutResult = data.variants.some(
    (v) => v.runStatus === 'failed' || v.runStatus === 'cancelled'
  );

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
            <Link href="/admin/orchestration/evaluations?tab=experiments">
              <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
              Back to experiments
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">{data.experimentName}</h1>
          <p className="text-muted-foreground text-sm">
            Side-by-side comparison of {data.variants.length} variant
            {data.variants.length === 1 ? '' : 's'} · {data.metricSlugs.length} metric
            {data.metricSlugs.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {noRunsYet ? (
        <Card>
          <CardHeader>
            <CardTitle>No comparison data yet</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            This experiment hasn&apos;t been run, or it ran via the legacy evaluation-session path.
            Dataset-driven runs produce the per-metric raw scores the compare view uses for
            Welch&apos;s t-test and Cohen&apos;s d.
          </CardContent>
        </Card>
      ) : (
        <>
          {someRunsStillQueued ? (
            <Card>
              <CardContent className="text-muted-foreground py-3 text-sm">
                Some variant runs are still queued or running. Stats below are computed against
                whatever has completed so far — refresh once all variants finish for the final
                comparison.
              </CardContent>
            </Card>
          ) : null}
          {someRunsEndedWithoutResult ? (
            <Card>
              <CardContent className="text-muted-foreground py-3 text-sm">
                Some variant runs failed or were cancelled, so those variants may have no scores
                below.
              </CardContent>
            </Card>
          ) : null}
          {judges === null ? (
            <LoadFailedNotice what="judge agents for the pairwise verdict" />
          ) : null}
          <PairwiseVerdictCard
            experimentId={id}
            verdict={data.pairwiseVerdict}
            judges={judges ?? []}
            variants={data.variants.map((v) => ({
              variantId: v.variantId,
              label: v.label,
              evaluationRunId: v.evaluationRunId,
              runStatus: v.runStatus,
            }))}
            caseCount={data.caseCount}
          />
          <VariantCompareTable variants={data.variants} metricSlugs={data.metricSlugs} />
        </>
      )}
    </div>
  );
}
