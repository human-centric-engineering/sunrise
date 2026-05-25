/**
 * /admin/orchestration/evaluations/datasets
 *
 * Server-rendered list of the caller's evaluation datasets. Renders the
 * Evaluation 101 card alongside the table when the list is empty, so a
 * first-time user lands on guidance + a single concrete next action
 * ("Upload a dataset") rather than a blank screen.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Evaluation101Card } from '@/components/admin/orchestration/evaluations-foundations/evaluation-101-card';
import {
  DatasetsTable,
  type DatasetListItem,
} from '@/components/admin/orchestration/evaluations-foundations/datasets-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Datasets · AI Orchestration',
  description: 'Test case collections used to run batch evaluations.',
};

async function loadDatasets(): Promise<DatasetListItem[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.EVAL_DATASETS}?limit=50`);
    if (!res.ok) {
      logger.warn('Failed to load datasets', { status: res.status });
      return [];
    }
    const parsed = await parseApiResponse<DatasetListItem[]>(res);
    if (!parsed.success) return [];
    return Array.isArray(parsed.data) ? parsed.data : [];
  } catch (err) {
    logger.error('Datasets list fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export default async function DatasetsListPage(): Promise<React.ReactElement> {
  const datasets = await loadDatasets();

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
        <h1 className="text-2xl font-semibold tracking-tight">Datasets</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Collections of test cases for batch evaluation runs.
        </p>
      </div>

      {datasets.length === 0 ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card>
            <CardContent className="text-muted-foreground py-12 text-center text-sm">
              <p>No datasets yet.</p>
              <Button asChild className="mt-4">
                <Link href="/admin/orchestration/evaluations/datasets/new">
                  Upload your first dataset
                </Link>
              </Button>
            </CardContent>
          </Card>
          <Evaluation101Card hideSection="datasets" />
        </div>
      ) : (
        <DatasetsTable datasets={datasets} />
      )}
    </div>
  );
}
