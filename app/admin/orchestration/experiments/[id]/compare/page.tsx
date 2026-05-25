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
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { VariantCompareTable } from '@/components/admin/orchestration/experiments/variant-compare-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

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
}

async function loadCompare(id: string): Promise<CompareResponse | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.experimentCompareById(id));
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.warn('Experiment compare: fetch failed', { id, status: res.status });
      return null;
    }
    const parsed = await parseApiResponse<CompareResponse>(res);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    logger.error('Experiment compare: fetch threw', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export default async function ExperimentComparePage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { id } = await params;

  const data = await loadCompare(id);
  if (!data) notFound();

  const noRunsYet = data.variants.every((v) => v.evaluationRunId === null);
  const someRunsStillQueued = data.variants.some(
    (v) => v.evaluationRunId !== null && v.runStatus !== 'completed'
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
          <VariantCompareTable variants={data.variants} metricSlugs={data.metricSlugs} />
        </>
      )}
    </div>
  );
}
