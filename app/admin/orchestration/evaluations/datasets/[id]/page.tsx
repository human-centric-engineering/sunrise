/**
 * /admin/orchestration/evaluations/datasets/:id
 *
 * Read-only dataset detail. Shows metadata + first 50 cases for preview.
 * (Edits land in a follow-up; Phase 1 keeps the surface minimal.)
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { datasetHelp } from '@/components/admin/orchestration/evaluations-foundations/help-text';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
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

async function loadDataset(id: string): Promise<DatasetDetail | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.evalDatasetById(id));
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.warn('Failed to load dataset detail', { id, status: res.status });
      return null;
    }
    const parsed = await parseApiResponse<DatasetDetail>(res);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    logger.error('Dataset detail fetch failed', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function summariseInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return '[unrenderable input]';
  }
}

export default async function DatasetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const detail = await loadDataset(id);
  if (!detail) notFound();

  const { dataset, cases } = detail;
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
        <Button asChild>
          <Link
            href={`/admin/orchestration/evaluations/runs/new?datasetId=${encodeURIComponent(dataset.id)}`}
          >
            Run against this dataset
          </Link>
        </Button>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">#</TableHead>
                <TableHead>Input</TableHead>
                <TableHead>Expected output</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono">{c.position}</TableCell>
                  <TableCell className="max-w-md">
                    <div className="line-clamp-3 text-xs whitespace-pre-wrap">
                      {summariseInput(c.input)}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-md">
                    <div className="line-clamp-3 text-xs whitespace-pre-wrap">
                      {c.expectedOutput ?? '—'}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
