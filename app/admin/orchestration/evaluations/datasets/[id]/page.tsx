/**
 * /admin/orchestration/evaluations/datasets/:id
 *
 * Read-only dataset detail. Shows metadata + first 50 cases for preview.
 * (Editing cases lands in a follow-up; this surface is intentionally minimal.)
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { datasetHelp } from '@/components/admin/orchestration/evaluations-foundations/help-text';
import { GenerateCasesButton } from '@/components/admin/orchestration/evaluations-foundations/generate-cases-button';
import { DatasetCasesTable } from '@/components/admin/orchestration/evaluations-foundations/dataset-cases-table';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Dataset · AI Orchestration',
};

interface DatasetDetailCase {
  id: string;
  position: number;
  input: unknown;
  expectedOutput: string | null;
  metadata: Record<string, unknown> | null;
}

interface DatasetDetail {
  dataset: {
    id: string;
    name: string;
    description: string | null;
    tags: string[];
    caseCount: number;
    contentHash: string;
    source: string;
    createdAt: string;
    updatedAt: string;
  };
  cases: DatasetDetailCase[];
}

interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

export default async function DatasetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  // The dataset is the page: a 404 is a missing dataset, any other failure
  // reaches the error boundary. The agent list only feeds the synthesis
  // button, so its failure shows a notice in the button's place.
  const [{ data: detail }, chatAgents] = await Promise.all([
    requireServerData<DatasetDetail>(API.ADMIN.ORCHESTRATION.evalDatasetById(id), {
      notFound: true,
    }),
    loadServerData<AgentOption[]>(`${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&kind=chat`),
  ]);

  const { dataset, cases } = detail;
  // A reply that is not a list counts as a failed load: the notice, rather
  // than a crash in the button.
  const agentOptions = chatAgents.ok && Array.isArray(chatAgents.data) ? chatAgents.data : null;
  if (chatAgents.ok && !agentOptions) {
    logger.error('Dataset detail: agents reply is not a list', undefined, {
      path: API.ADMIN.ORCHESTRATION.AGENTS,
    });
  }
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

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{dataset.name}</h1>
          {dataset.description ? (
            <p className="text-muted-foreground mt-1 text-sm">{dataset.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {agentOptions ? (
            <GenerateCasesButton datasetId={dataset.id} agents={agentOptions} />
          ) : (
            <LoadFailedNotice what="chat agents for case generation" />
          )}
          <Button asChild>
            <Link
              href={`/admin/orchestration/evaluations/runs/new?datasetId=${encodeURIComponent(dataset.id)}`}
            >
              Run against this dataset
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Cases</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-medium">{dataset.caseCount}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Source</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">{dataset.source}</Badge>{' '}
            <FieldHelp title="Source">{datasetHelp.source}</FieldHelp>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">
              Content hash <FieldHelp title="Content hash">{datasetHelp.contentHash}</FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs">
            {dataset.contentHash.slice(0, 16)}…
          </CardContent>
        </Card>
      </div>

      {dataset.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {dataset.tags.map((t) => (
            <Badge key={t} variant="secondary">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">First {cases.length} cases</CardTitle>
        </CardHeader>
        <CardContent>
          <DatasetCasesTable
            datasetId={dataset.id}
            initialCases={cases.map((c) => ({
              id: c.id,
              position: c.position,
              input: c.input,
              expectedOutput: c.expectedOutput,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
