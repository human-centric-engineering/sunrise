/**
 * /admin/orchestration/evaluations/datasets/new
 *
 * Server page that renders a tabbed surface for the two ways to start
 * a dataset: upload a CSV/JSONL file, or generate cases from a domain
 * description. The "Anatomy of a case" sidebar sits next to both tabs
 * so the schema worked example is always visible.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DatasetAnatomyCard } from '@/components/admin/orchestration/evaluations-foundations/dataset-anatomy-card';
import { DatasetNewTabs } from '@/components/admin/orchestration/evaluations-foundations/dataset-new-tabs';
import type { AgentOption } from '@/components/admin/orchestration/evaluations-foundations/generate-from-description-form';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';

export const metadata: Metadata = {
  title: 'New dataset · AI Orchestration',
  description: 'Upload a CSV or JSONL dataset, or generate cases from a description.',
};

export default async function NewDatasetPage(): Promise<React.ReactElement> {
  // Only the generate tab needs the agents. On an empty list that tab tells
  // the admin to create an agent, so a failed load must not reach it as `[]`:
  // it passes `null`, and the generate tab shows a "Couldn't load" notice
  // while the upload tab still works (#518).
  const agentsLoad = await loadServerData<AgentOption[]>(
    `${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&kind=chat`
  );
  const agents = agentsLoad.ok ? agentsLoad.data : null;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin/orchestration/evaluations/datasets">
            <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
            Datasets
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New dataset</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Upload a CSV or JSONL file, or generate cases from a description. The required column is{' '}
          <code className="bg-muted rounded px-1 text-xs">input</code>; everything else is optional.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <DatasetNewTabs agents={agents} />
        <DatasetAnatomyCard />
      </div>
    </div>
  );
}
