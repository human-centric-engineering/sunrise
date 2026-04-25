'use client';

/**
 * ExecutionsTable — admin list view for workflow executions.
 *
 * Features:
 *   - Status filter dropdown (all, running, completed, failed, cancelled, paused_for_approval).
 *   - workflowId filter (pre-populated when arriving from the workflows table link).
 *   - Pagination with prev/next.
 *   - Row links to /admin/orchestration/executions/:id for trace detail.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tip } from '@/components/ui/tooltip';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/app/admin/orchestration/executions/page';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'paused_for_approval', label: 'Awaiting approval' },
] as const;

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
  paused_for_approval: 'outline',
  pending: 'outline',
};

export interface ExecutionsTableProps {
  initialExecutions: ExecutionListItem[];
  initialMeta: PaginationMeta;
  initialWorkflowId?: string;
}

export function ExecutionsTable({
  initialExecutions,
  initialMeta,
  initialWorkflowId,
}: ExecutionsTableProps) {
  const [executions, setExecutions] = useState(initialExecutions);
  const [meta, setMeta] = useState(initialMeta);
  const [statusFilter, setStatusFilter] = useState('all');
  const [workflowId] = useState(initialWorkflowId ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchExecutions = useCallback(
    async (page = 1, overrides?: { status?: string }) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
        });
        const status = overrides?.status ?? statusFilter;
        if (status && status !== 'all') params.set('status', status);
        if (workflowId) params.set('workflowId', workflowId);

        const res = await fetch(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('fetch failed');

        const body = await parseApiResponse<ExecutionListItem[]>(res);
        if (!body.success) throw new Error('parse failed');

        setExecutions(body.data);
        const parsedMeta = parsePaginationMeta(body.meta);
        if (parsedMeta) setMeta(parsedMeta);
      } catch {
        setError('Could not load executions. Try refreshing the page.');
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit, statusFilter, workflowId]
  );

  const handleStatusChange = useCallback(
    (value: string) => {
      setStatusFilter(value);
      void fetchExecutions(1, { status: value });
    },
    [fetchExecutions]
  );

  const handlePage = useCallback(
    (page: number) => {
      void fetchExecutions(page);
    },
    [fetchExecutions]
  );

  function formatDuration(start: string | null, end: string | null): string {
    if (!start) return '—';
    const startMs = new Date(start).getTime();
    const endMs = end ? new Date(end).getTime() : Date.now();
    if (Number.isNaN(startMs)) return '—';
    const ms = endMs - startMs;
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {workflowId && (
          <Badge variant="secondary" className="text-xs">
            Filtered by workflow
          </Badge>
        )}
      </div>

      {error && (
        <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Execution</TableHead>
              <TableHead>Workflow</TableHead>
              <TableHead>
                <Tip label="Current execution status">
                  <span>Status</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Total tokens consumed across all steps">
                  <span>Tokens</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Total cost in USD">
                  <span>Cost</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Wall-clock duration from start to completion">
                  <span>Duration</span>
                </Tip>
              </TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && executions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  Loading…
                </TableCell>
              </TableRow>
            ) : executions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  No executions found.
                </TableCell>
              </TableRow>
            ) : (
              executions.map((ex) => (
                <TableRow key={ex.id}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/admin/orchestration/executions/${ex.id}`}
                      className="hover:underline"
                    >
                      {ex.id.slice(0, 8)}…
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/orchestration/workflows/${ex.workflowId}`}
                      className="hover:underline"
                    >
                      {ex.workflow.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[ex.status] ?? 'outline'}>
                      {ex.status.replace(/_/g, ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {ex.totalTokensUsed.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    ${ex.totalCostUsd.toFixed(4)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDuration(ex.startedAt, ex.completedAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDate(ex.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Button asChild variant="ghost" size="sm" className="h-8 w-8 p-0">
                      <Link
                        href={`/admin/orchestration/executions/${ex.id}`}
                        title="View execution trace"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Showing {executions.length === 0 ? 0 : (meta.page - 1) * meta.limit + 1} to{' '}
          {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} executions
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePage(meta.page - 1)}
            disabled={meta.page <= 1 || isLoading}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <span className="text-sm">
            Page {meta.page} of {meta.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePage(meta.page + 1)}
            disabled={meta.page >= meta.totalPages || isLoading}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
