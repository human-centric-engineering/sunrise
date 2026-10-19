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

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  KeyRound,
  MoreHorizontal,
  StopCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { LeaseInspectorDialog } from '@/components/admin/orchestration/lease-inspector-dialog';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { formatDuration } from '@/lib/utils/format-duration';
import { formatStatus } from '@/lib/utils/format-status';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/types/orchestration';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
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
  initialStatus?: string;
  /**
   * Minutes a running step may run before its row is highlighted as
   * stuck-looking. Sourced from `AiOrchestrationSettings`; falls back
   * to 5 if missing.
   */
  stuckThresholdMins?: number;
  /**
   * Show the live-engine controls on each row: the lease inspector and
   * force-fail. Both act on engine state the platform runs for every org, and
   * their routes admit a platform admin only, so an org viewer's table
   * (§111 t-812) leaves them out. Defaults to shown.
   */
  engineControls?: boolean;
}

const FORCE_FAILABLE = new Set<string>(['running', 'pending', 'paused_for_approval']);

export function ExecutionsTable({
  initialExecutions,
  initialMeta,
  initialWorkflowId,
  initialStatus,
  stuckThresholdMins = 5,
  engineControls = true,
}: ExecutionsTableProps): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [executions, setExecutions] = useState(initialExecutions);
  const [meta, setMeta] = useState(initialMeta);
  const [statusFilter, setStatusFilter] = useState(initialStatus ?? 'all');
  const [workflowId] = useState(initialWorkflowId ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaseInspectorId, setLeaseInspectorId] = useState<string | null>(null);
  const [forceFailTarget, setForceFailTarget] = useState<ExecutionListItem | null>(null);
  const [forceFailReason, setForceFailReason] = useState('');
  const [forceFailError, setForceFailError] = useState<string | null>(null);
  const [forceFailSubmitting, setForceFailSubmitting] = useState(false);

  const stuckThresholdMs = Math.max(1, stuckThresholdMins) * 60_000;

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

      // Sync filter to URL for bookmarking/sharing
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'all') {
        params.delete('status');
      } else {
        params.set('status', value);
      }
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [fetchExecutions, router, searchParams]
  );

  // React to externally-driven `status` changes — e.g. the live-engine
  // dashboard cards sitting above the table pushing `?status=running`
  // via `router.replace`. Without this effect the URL would update but
  // the table state and fetched rows would not, so clicking the
  // Running card would silently do nothing.
  //
  // Two guards:
  //  1. `mountedRef` skips the first render. `initialStatus` already
  //     reflects the URL at SSR time (the page reads
  //     `resolvedParams.status` and passes it down); re-reading
  //     `searchParams` on mount and overwriting it would clobber a
  //     server-rendered filter when `searchParams` is briefly empty
  //     during hydration.
  //  2. `urlStatus === statusFilter` short-circuits the case where
  //     the in-table dropdown initiated the URL change itself
  //     (`handleStatusChange` sets state AND pushes the URL).
  const mountedRef = useRef(false);
  // Depend on the stable string form (`searchParams.toString()`), NOT
  // on `searchParams` itself. The Next.js mock in tests returns a
  // fresh `URLSearchParams` instance per render — using the reference
  // as a dep would fire this effect on every render and overwrite
  // local state. In production `useSearchParams()` is stable across
  // re-renders within the same URL, but the string is the
  // value-equality form we actually care about either way.
  const searchParamsKey = searchParams.toString();
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const rawStatus = new URLSearchParams(searchParamsKey).get('status') ?? 'all';
    // A value the menu does not offer (a stale or hand-edited link) is no
    // filter: the API answers it 400, and the page already ignored it.
    const urlStatus = STATUS_OPTIONS.some((opt) => opt.value === rawStatus) ? rawStatus : 'all';
    if (urlStatus !== statusFilter) {
      setStatusFilter(urlStatus);
      void fetchExecutions(1, { status: urlStatus });
    }
    // `fetchExecutions` is stable per (limit, statusFilter, workflowId)
    // — `statusFilter` is intentionally absent from the deps to avoid
    // a feedback loop on the same render that sets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParamsKey]);

  const handlePage = useCallback(
    (page: number) => {
      void fetchExecutions(page);
    },
    [fetchExecutions]
  );

  const handleForceFailConfirm = useCallback(async () => {
    if (!forceFailTarget) return;
    setForceFailSubmitting(true);
    setForceFailError(null);
    try {
      const reason = forceFailReason.trim();
      const res = await fetch(API.ADMIN.ORCHESTRATION.executionForceFail(forceFailTarget.id), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      });
      if (!res.ok) {
        // Surface the server's error message from the shared
        // `{ success:false, error: { message } }` envelope when present;
        // otherwise fall back to the HTTP status. JSON parse failures
        // are intentionally swallowed to the same fallback so a malformed
        // body never replaces a meaningful status code.
        const parsed: unknown = await res.json().catch(() => null);
        let message = `HTTP ${res.status}`;
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          const err = (parsed as { error?: unknown }).error;
          if (err && typeof err === 'object' && 'message' in err) {
            const m = (err as { message?: unknown }).message;
            if (typeof m === 'string' && m.length > 0) message = m;
          }
        }
        throw new Error(message);
      }
      setForceFailTarget(null);
      setForceFailReason('');
      void fetchExecutions(meta.page);
    } catch (err) {
      setForceFailError(err instanceof Error ? err.message : 'Force-fail failed');
    } finally {
      setForceFailSubmitting(false);
    }
  }, [fetchExecutions, forceFailReason, forceFailTarget, meta.page]);

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Render the step-age column as the largest sensible unit. Sub-
   * second values stay in ms because the only time you see one is a
   * fresh fast step caught mid-poll; everything else rounds to whole
   * units so the column stays narrow.
   */
  function formatStepAge(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
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
              <TableHead>Execution ID</TableHead>
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
              <TableHead>
                <Tip
                  label={
                    engineControls
                      ? `Time the running step has been in flight. Rows past ${stuckThresholdMins}m are highlighted amber but NOT auto-failed — use the row menu to force-fail if needed. Threshold is set in Settings → Limits.`
                      : `Time the running step has been in flight. Rows past ${stuckThresholdMins}m are highlighted amber.`
                  }
                >
                  <span>Step age</span>
                </Tip>
              </TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && executions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center">
                  Loading…
                </TableCell>
              </TableRow>
            ) : executions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center">
                  No executions found.
                </TableCell>
              </TableRow>
            ) : (
              executions.map((ex) => {
                const isStuck =
                  ex.timeInCurrentStepMs !== null && ex.timeInCurrentStepMs >= stuckThresholdMs;
                const canForceFail = FORCE_FAILABLE.has(ex.status);
                return (
                  <TableRow
                    key={ex.id}
                    className={isStuck ? 'bg-amber-50 dark:bg-amber-950/30' : undefined}
                  >
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
                        {formatStatus(ex.status)}
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
                    <TableCell className="text-xs">
                      {ex.timeInCurrentStepMs === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={
                            isStuck
                              ? 'inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300'
                              : undefined
                          }
                          title={
                            isStuck
                              ? `Exceeds the ${stuckThresholdMins}m stuck threshold`
                              : undefined
                          }
                        >
                          {isStuck && <AlertTriangle className="h-3 w-3" aria-hidden />}
                          {formatStepAge(ex.timeInCurrentStepMs)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(ex.createdAt)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <span className="sr-only">Row actions</span>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Execution actions</DropdownMenuLabel>
                          <DropdownMenuItem asChild>
                            <Link href={`/admin/orchestration/executions/${ex.id}`}>
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View trace
                            </Link>
                          </DropdownMenuItem>
                          {engineControls && (
                            <>
                              <DropdownMenuItem onSelect={() => setLeaseInspectorId(ex.id)}>
                                <KeyRound className="mr-2 h-4 w-4" />
                                View lease
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={!canForceFail}
                                onSelect={() => {
                                  if (!canForceFail) return;
                                  setForceFailTarget(ex);
                                  setForceFailReason('');
                                  setForceFailError(null);
                                }}
                                className="text-red-600 focus:text-red-700"
                              >
                                <StopCircle className="mr-2 h-4 w-4" />
                                Force fail…
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <LeaseInspectorDialog
        executionId={leaseInspectorId}
        onClose={() => setLeaseInspectorId(null)}
      />

      <AlertDialog
        open={forceFailTarget !== null}
        onOpenChange={(next) => {
          if (!next && !forceFailSubmitting) {
            setForceFailTarget(null);
            setForceFailReason('');
            setForceFailError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force-fail this execution?</AlertDialogTitle>
            <AlertDialogDescription>
              The execution will be transitioned to <strong>failed</strong> immediately. Any
              partially-completed side-effects (external calls, notifications) remain — this action
              does not roll them back. The reason is recorded in the admin audit log, and any
              subscribers to <code>workflow.failed</code> or <code>execution.force_failed</code>{' '}
              hooks will be notified.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="force-fail-reason">Reason (optional)</Label>
            <Textarea
              id="force-fail-reason"
              value={forceFailReason}
              onChange={(e) => setForceFailReason(e.target.value)}
              maxLength={500}
              placeholder="e.g. Vendor API returning malformed data; engineering investigating."
              rows={3}
              disabled={forceFailSubmitting}
            />
          </div>
          {forceFailError && <p className="text-destructive text-sm">{forceFailError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forceFailSubmitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={forceFailSubmitting}
              onClick={(e) => {
                e.preventDefault();
                void handleForceFailConfirm();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {forceFailSubmitting ? 'Force-failing…' : 'Force fail'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
