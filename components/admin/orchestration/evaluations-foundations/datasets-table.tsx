/**
 * DatasetsTable — read-only list view for /admin/orchestration/evaluations/datasets.
 *
 * Server component pattern: the page loads data via `serverFetch` and
 * passes it down; the table itself stays presentational. Single
 * "Delete" action per row is wired via a small client wrapper so we
 * don't need full client-side state.
 */

import * as React from 'react';
import Link from 'next/link';
import { Database, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface DatasetListItem {
  id: string;
  name: string;
  description?: string | null;
  tags: string[];
  caseCount: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface DatasetsTableProps {
  datasets: DatasetListItem[];
}

export function DatasetsTable({ datasets }: DatasetsTableProps): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="text-muted-foreground h-4 w-4" aria-hidden />
          <h2 className="text-base font-medium">Datasets</h2>
          <span className="text-muted-foreground text-xs">{datasets.length} total</span>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/orchestration/evaluations/datasets/new">
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            Upload dataset
          </Link>
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-24">Cases</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead className="w-32">Source</TableHead>
            <TableHead className="w-36">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {datasets.map((d) => (
            <TableRow key={d.id}>
              <TableCell>
                <Link
                  href={`/admin/orchestration/evaluations/datasets/${d.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {d.name}
                </Link>
                {d.description ? (
                  <p className="text-muted-foreground line-clamp-1 text-xs">{d.description}</p>
                ) : null}
              </TableCell>
              <TableCell className="font-mono">{d.caseCount}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {d.tags.length === 0 ? (
                    <span className="text-muted-foreground text-xs">—</span>
                  ) : (
                    d.tags.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[10px]">
                        {t}
                      </Badge>
                    ))
                  )}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-[10px]">
                  {d.source}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {new Date(d.updatedAt).toLocaleDateString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
