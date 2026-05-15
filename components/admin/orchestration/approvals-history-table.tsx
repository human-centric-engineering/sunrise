'use client';

/**
 * ApprovalsHistoryTable — admin view of past approval decisions.
 *
 * Backed by `GET /api/v1/admin/orchestration/approvals/history`, which
 * flattens `human_approval` trace entries to one row per decision. This
 * component owns filter state, pagination, and the CSV download — it
 * does NOT fetch initial data, so the parent can render an empty shell
 * while the first list loads on mount.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Download, Loader2, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { logger } from '@/lib/logging';
import type { PaginationMeta } from '@/types/api';
import type { ApprovalHistoryEntry } from '@/types/orchestration';

// ─── Filter state ──────────────────────────────────────────────────────────

type DecisionFilter = 'all' | 'approved' | 'rejected';
type MediumFilter = 'all' | 'admin' | 'token';

interface Filters {
  decision: DecisionFilter;
  medium: MediumFilter;
  q: string;
  dateFrom: string;
  dateTo: string;
}

const DEFAULT_FILTERS: Filters = {
  decision: 'all',
  medium: 'all',
  q: '',
  dateFrom: '',
  dateTo: '',
};

const EMPTY_META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human-readable wait time. Sub-minute waits collapse to seconds. */
function formatWait(ms: number): string {
  if (ms < 1000) return '0s';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

const MEDIUM_LABEL: Record<ApprovalHistoryEntry['medium'], string> = {
  admin: 'Admin UI',
  'token-external': 'Token · External',
  'token-chat': 'Token · Chat',
  'token-embed': 'Token · Embed',
  unknown: 'Unknown',
};

/**
 * Serialise the active filter state into a URLSearchParams instance that
 * matches the backend query schema. The empty/`'all'` selections are
 * dropped so the server defaults apply.
 */
function buildQuery(filters: Filters, page: number, limit: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  if (filters.decision !== 'all') params.set('decision', filters.decision);
  if (filters.medium !== 'all') params.set('medium', filters.medium);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  // Inclusive `to`: roll the date to end-of-day so the picker behaves
  // intuitively when the user wants "everything up to today".
  if (filters.dateTo) params.set('dateTo', `${filters.dateTo}T23:59:59.999Z`);
  return params;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function ApprovalsHistoryTable(): ReactElement {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [rows, setRows] = useState<ApprovalHistoryEntry[]>([]);
  const [meta, setMeta] = useState<PaginationMeta>(EMPTY_META);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const fetchPage = useCallback(
    async (page: number, nextFilters: Filters) => {
      setIsLoading(true);
      setError(null);
      const params = buildQuery(nextFilters, page, meta.limit);
      try {
        const res = await fetch(`${API.ADMIN.ORCHESTRATION.APPROVALS_HISTORY}?${params}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await parseApiResponse<ApprovalHistoryEntry[]>(res);
        if (!body.success) throw new Error('parse failed');
        setRows(body.data);
        const parsedMeta = parsePaginationMeta(body.meta);
        if (parsedMeta) setMeta(parsedMeta);
      } catch (err) {
        logger.error('approvals history fetch failed', err);
        setError('Could not load approval history. Try refreshing.');
        setRows([]);
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit]
  );

  // Initial load + reload whenever filters change. Debounced on the text
  // search so each keystroke doesn't slam the backend.
  useEffect(() => {
    const handle = setTimeout(() => {
      void fetchPage(1, filters);
    }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.decision, filters.medium, filters.dateFrom, filters.dateTo, filters.q]);

  const hasActiveFilters = useMemo(
    () =>
      filters.decision !== 'all' ||
      filters.medium !== 'all' ||
      !!filters.q.trim() ||
      !!filters.dateFrom ||
      !!filters.dateTo,
    [filters]
  );

  const handleResetFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);

  const handlePrev = useCallback(() => {
    if (meta.page > 1) void fetchPage(meta.page - 1, filters);
  }, [fetchPage, filters, meta.page]);

  const handleNext = useCallback(() => {
    if (meta.page < meta.totalPages) void fetchPage(meta.page + 1, filters);
  }, [fetchPage, filters, meta.page, meta.totalPages]);

  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const params = buildQuery(filters, 1, meta.limit);
      params.set('format', 'csv');
      // Strip pagination — CSV ignores it but the params still ship.
      const res = await fetch(`${API.ADMIN.ORCHESTRATION.APPROVALS_HISTORY}?${params}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `approvals-history-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.error('approvals history CSV export failed', err);
      setError('Could not export CSV. Try refreshing.');
    } finally {
      setExporting(false);
    }
  }, [filters, meta.limit]);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto]">
        <div className="space-y-1">
          <Label htmlFor="approval-history-q" className="text-xs">
            Search
          </Label>
          <Input
            id="approval-history-q"
            type="search"
            placeholder="Workflow, step, or approver"
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Decision</Label>
          <Select
            value={filters.decision}
            onValueChange={(v) => setFilters((f) => ({ ...f, decision: v as DecisionFilter }))}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Medium</Label>
          <Select
            value={filters.medium}
            onValueChange={(v) => setFilters((f) => ({ ...f, medium: v as MediumFilter }))}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="admin">Admin UI</SelectItem>
              <SelectItem value="token">Token</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="approval-history-from" className="text-xs">
            From
          </Label>
          <Input
            id="approval-history-from"
            type="date"
            value={filters.dateFrom}
            onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="approval-history-to" className="text-xs">
            To
          </Label>
          <Input
            id="approval-history-to"
            type="date"
            value={filters.dateTo}
            onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-muted-foreground text-xs">
          {isLoading ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </span>
          ) : (
            `${meta.total.toLocaleString()} ${meta.total === 1 ? 'decision' : 'decisions'}`
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <Button type="button" size="sm" variant="ghost" onClick={handleResetFilters}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Reset
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleExportCsv()}
            disabled={exporting || meta.total === 0}
          >
            {exporting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 h-3.5 w-3.5" />
            )}
            Export CSV
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {error}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Decision</TableHead>
              <TableHead>Medium</TableHead>
              <TableHead>Approver</TableHead>
              <TableHead>Asked</TableHead>
              <TableHead>Decided</TableHead>
              <TableHead>Wait</TableHead>
              <TableHead>Notes / Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground text-center text-sm">
                  No decisions match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-[14rem]">
                    <Link
                      href={`/admin/orchestration/executions/${row.executionId}`}
                      className="text-primary hover:underline"
                    >
                      {row.workflowName}
                    </Link>
                    <div className="text-muted-foreground truncate text-xs">{row.stepLabel}</div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={row.decision === 'approved' ? 'secondary' : 'destructive'}
                      className="capitalize"
                    >
                      {row.decision}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {MEDIUM_LABEL[row.medium] ?? row.medium}
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.medium === 'admin' ? (
                      (row.approverName ?? (
                        <span className="text-muted-foreground italic">deleted user</span>
                      ))
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    <Tip label={new Date(row.askedAt).toISOString()}>
                      <span>{formatDateTime(row.askedAt)}</span>
                    </Tip>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    <Tip label={new Date(row.decidedAt).toISOString()}>
                      <span>{formatDateTime(row.decidedAt)}</span>
                    </Tip>
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {formatWait(row.waitDurationMs)}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-[18rem] truncate text-xs">
                    {row.notes ?? row.reason ?? ''}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            Page {meta.page} of {meta.totalPages}
          </span>
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handlePrev}
              disabled={meta.page <= 1 || isLoading}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleNext}
              disabled={meta.page >= meta.totalPages || isLoading}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
