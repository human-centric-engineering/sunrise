/**
 * /admin/orchestration/evaluations/runs
 *
 * Server-rendered list of batch evaluation runs. Renders the Evaluation
 * 101 card alongside the table when the list is empty.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Evaluation101Card } from '@/components/admin/orchestration/evaluations-foundations/evaluation-101-card';
import {
  RunsTable,
  type RunListItem,
} from '@/components/admin/orchestration/evaluations-foundations/runs-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Batch runs · AI Orchestration',
  description: 'Dataset-driven evaluation runs.',
};

async function loadRuns(): Promise<RunListItem[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.EVAL_RUNS}?limit=50`);
    if (!res.ok) {
      logger.warn('Failed to load runs', { status: res.status });
      return [];
    }
    const parsed = await parseApiResponse<RunListItem[]>(res);
    if (!parsed.success) return [];
    return Array.isArray(parsed.data) ? parsed.data : [];
  } catch (err) {
    logger.error('Runs list fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export default async function RunsListPage(): Promise<React.ReactElement> {
  const runs = await loadRuns();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin/orchestration/evaluations">
            <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
            Testing
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Batch runs</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Dataset × subject × graders. The worker processes runs in the background.
        </p>
      </div>

      {runs.length === 0 ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card>
            <CardContent className="text-muted-foreground py-12 text-center text-sm">
              <p>No runs yet.</p>
              <Button asChild className="mt-4">
                <Link href="/admin/orchestration/evaluations/runs/new">Queue your first run</Link>
              </Button>
            </CardContent>
          </Card>
          <Evaluation101Card hideSection="runs" />
        </div>
      ) : (
        <RunsTable runs={runs} />
      )}
    </div>
  );
}
