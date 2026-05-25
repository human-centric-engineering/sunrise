/**
 * RunsTable — list view for evaluation runs.
 *
 * Server-renderable. Shows: name, subject (agent or workflow), dataset,
 * status badge, progress %, last update. Click-through to detail page.
 */

import Link from 'next/link';
import { Play, Plus } from 'lucide-react';

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

export interface RunListItem {
  id: string;
  name: string;
  subjectKind: 'agent' | 'workflow';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  agent: { id: string; name: string; slug: string } | null;
  workflow: { id: string; name: string; slug: string } | null;
  dataset: { id: string; name: string; caseCount: number } | null;
  progress: { casesTotal: number; casesDone: number; casesFailed: number } | null;
  totalCostUsd: number | null;
  updatedAt: string;
}

const STATUS_STYLES: Record<RunListItem['status'], string> = {
  queued: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  cancelled: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
};

interface RunsTableProps {
  runs: RunListItem[];
}

function progressPercent(p: RunListItem['progress']): string {
  if (!p || !p.casesTotal) return '—';
  const pct = Math.floor((p.casesDone / p.casesTotal) * 100);
  return `${pct}% (${p.casesDone}/${p.casesTotal})`;
}

export function RunsTable({ runs }: RunsTableProps): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Play className="text-muted-foreground h-4 w-4" aria-hidden />
          <h2 className="text-base font-medium">Batch runs</h2>
          <span className="text-muted-foreground text-xs">{runs.length} total</span>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/orchestration/evaluations/runs/new">
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            New run
          </Link>
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Dataset</TableHead>
            <TableHead className="w-32">Status</TableHead>
            <TableHead className="w-40">Progress</TableHead>
            <TableHead className="w-28">Cost</TableHead>
            <TableHead className="w-36">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link
                  href={`/admin/orchestration/evaluations/runs/${r.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {r.name}
                </Link>
              </TableCell>
              <TableCell className="text-sm">
                {r.subjectKind === 'agent' && r.agent ? (
                  <>
                    <Badge variant="outline" className="text-[10px]">
                      agent
                    </Badge>{' '}
                    {r.agent.name}
                  </>
                ) : r.subjectKind === 'workflow' && r.workflow ? (
                  <>
                    <Badge variant="outline" className="text-[10px]">
                      workflow
                    </Badge>{' '}
                    {r.workflow.name}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {r.dataset ? r.dataset.name : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>
                <Badge className={`${STATUS_STYLES[r.status]} text-[10px]`}>{r.status}</Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">{progressPercent(r.progress)}</TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">
                {r.totalCostUsd != null ? `$${r.totalCostUsd.toFixed(4)}` : '—'}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {new Date(r.updatedAt).toLocaleDateString('en-GB', {
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
