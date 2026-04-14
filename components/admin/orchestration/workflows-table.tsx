'use client';

/**
 * WorkflowsTable — admin list view for AI workflows.
 *
 * Modelled on `AgentsTable` but simpler: no bulk export, no per-row
 * lazy fetch (Phase 5.1a focuses on the builder, not reporting).
 *
 * Features:
 *   - Debounced search (300 ms) against the `q` query param.
 *   - Template badge + pattern-count chip per row.
 *   - Optimistic `isActive` Switch that reverts on failure.
 *   - Row actions dropdown: Edit, Delete (soft-delete via DELETE).
 *   - Client-side sort by name or createdAt (server returns createdAt desc).
 */

import type { AiWorkflow } from '@prisma/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Edit,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';

type ExecutionCountEntry = number | null;

export interface WorkflowsTableProps {
  initialWorkflows: AiWorkflow[];
  initialMeta: PaginationMeta;
}

type SortField = 'createdAt' | 'name';

export function WorkflowsTable({ initialWorkflows, initialMeta }: WorkflowsTableProps) {
  const router = useRouter();
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [isLoading, setIsLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AiWorkflow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [execCounts, setExecCounts] = useState<Record<string, ExecutionCountEntry>>({});
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  // Lazy-fetch execution count per visible workflow.
  useEffect(() => {
    if (workflows.length === 0) return;
    let cancelled = false;

    void (async () => {
      const entries = await Promise.all(
        workflows.map(async (wf): Promise<[string, ExecutionCountEntry]> => {
          try {
            const res = await fetch(
              `${API.ADMIN.ORCHESTRATION.EXECUTIONS}?workflowId=${wf.id}&limit=1&page=1`,
              { credentials: 'same-origin' }
            );
            if (!res.ok) return [wf.id, null];
            const body = await parseApiResponse<unknown[]>(res);
            if (!body.success) return [wf.id, null];
            const pMeta = parsePaginationMeta(body.meta);
            return [wf.id, pMeta?.total ?? null];
          } catch {
            return [wf.id, null];
          }
        })
      );
      if (cancelled) return;
      setExecCounts(Object.fromEntries(entries));
    })();

    return () => {
      cancelled = true;
    };
  }, [workflows]);

  const fetchWorkflows = useCallback(
    async (
      page = 1,
      overrides?: { search?: string; sortField?: SortField; sortOrder?: 'asc' | 'desc' }
    ) => {
      setIsLoading(true);
      setListError(null);
      try {
        const searchValue = overrides?.search !== undefined ? overrides.search : search;
        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
        });
        if (searchValue) params.set('q', searchValue);

        const res = await fetch(`${API.ADMIN.ORCHESTRATION.WORKFLOWS}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('list failed');

        const body = await parseApiResponse<AiWorkflow[]>(res);
        if (!body.success) throw new Error('list failed');

        const next = [...body.data];
        const field = overrides?.sortField ?? sortField;
        const order = overrides?.sortOrder ?? sortOrder;
        next.sort((a, b) => {
          const av = field === 'name' ? a.name.toLowerCase() : new Date(a.createdAt).getTime();
          const bv = field === 'name' ? b.name.toLowerCase() : new Date(b.createdAt).getTime();
          if (av < bv) return order === 'asc' ? -1 : 1;
          if (av > bv) return order === 'asc' ? 1 : -1;
          return 0;
        });
        setWorkflows(next);

        const parsedMeta = parsePaginationMeta(body.meta);
        if (parsedMeta) setMeta(parsedMeta);
      } catch {
        setListError('Could not load workflows. Try refreshing the page.');
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit, search, sortField, sortOrder]
  );

  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        void fetchWorkflows(1, { search: value });
      }, 300);
    },
    [fetchWorkflows]
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const nextOrder: 'asc' | 'desc' =
        sortField === field ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'desc';
      setSortField(field);
      setSortOrder(nextOrder);
      void fetchWorkflows(meta.page, { sortField: field, sortOrder: nextOrder });
    },
    [fetchWorkflows, meta.page, sortField, sortOrder]
  );

  const handlePage = useCallback(
    (page: number) => {
      void fetchWorkflows(page);
    },
    [fetchWorkflows]
  );

  const handleToggleStatus = useCallback(async (workflow: AiWorkflow, nextActive: boolean) => {
    setWorkflows((prev) =>
      prev.map((w) => (w.id === workflow.id ? { ...w, isActive: nextActive } : w))
    );
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.workflowById(workflow.id), {
        body: { isActive: nextActive },
      });
    } catch (err) {
      setWorkflows((prev) =>
        prev.map((w) => (w.id === workflow.id ? { ...w, isActive: workflow.isActive } : w))
      );
      setListError(
        err instanceof APIClientError
          ? `Couldn't update "${workflow.name}": ${err.message}`
          : `Couldn't update "${workflow.name}". Try again.`
      );
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setIsLoading(true);
    setDeleteError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.workflowById(deleteTarget.id));
      setDeleteTarget(null);
      void fetchWorkflows(meta.page);
    } catch (err) {
      setDeleteError(
        err instanceof APIClientError ? err.message : 'Delete failed. Try again in a moment.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [deleteTarget, fetchWorkflows, meta.page]);

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="ml-2 h-4 w-4" />;
    return sortOrder === 'asc' ? (
      <ArrowUp className="ml-2 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-2 h-4 w-4" />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder="Search workflows..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button asChild size="sm">
          <Link href="/admin/orchestration/workflows/new">
            <Plus className="mr-2 h-4 w-4" />
            New workflow
          </Link>
        </Button>
      </div>

      {listError && (
        <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {listError}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Button variant="ghost" className="-ml-4 h-8" onClick={() => handleSort('name')}>
                  Name
                  {renderSortIcon('name')}
                </Button>
              </TableHead>
              <TableHead title="URL-safe identifier used in API calls and URLs">Slug</TableHead>
              <TableHead>Description</TableHead>
              <TableHead
                className="text-center"
                title="Number of pattern blocks (steps) in this workflow"
              >
                Patterns
              </TableHead>
              <TableHead
                className="text-center"
                title='Templates appear in the "Use template" menu when creating new workflows'
              >
                Template
              </TableHead>
              <TableHead className="text-right" title="Total times this workflow has been executed">
                Runs
              </TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && workflows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  Loading…
                </TableCell>
              </TableRow>
            ) : workflows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  No workflows found. Click{' '}
                  <Link href="/admin/orchestration/workflows/new" className="font-medium underline">
                    New workflow
                  </Link>{' '}
                  to build one.
                </TableCell>
              </TableRow>
            ) : (
              workflows.map((workflow) => (
                <TableRow key={workflow.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/orchestration/workflows/${workflow.id}`}
                      className="hover:underline"
                    >
                      {workflow.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {workflow.slug}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
                    {workflow.description || '—'}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="secondary">{workflow.patternsUsed.length}</Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    {workflow.isTemplate ? (
                      <Badge title='This workflow appears in the "Use template" menu when creating new workflows'>
                        Template
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {execCounts[workflow.id] === undefined ? (
                      <span className="text-muted-foreground">…</span>
                    ) : execCounts[workflow.id] === null ? (
                      '—'
                    ) : execCounts[workflow.id] === 0 ? (
                      <span className="text-muted-foreground">0</span>
                    ) : (
                      <Link
                        href={`/admin/orchestration/executions?workflowId=${workflow.id}`}
                        className="hover:underline"
                        title="View executions for this workflow"
                      >
                        {execCounts[workflow.id]}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={workflow.isActive}
                      onCheckedChange={(v) => void handleToggleStatus(workflow, v)}
                      aria-label={`Toggle ${workflow.name} active`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                          <span className="sr-only">Row actions</span>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() =>
                            router.push(`/admin/orchestration/workflows/${workflow.id}`)
                          }
                        >
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => setDeleteTarget(workflow)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Showing {workflows.length === 0 ? 0 : (meta.page - 1) * meta.limit + 1} to{' '}
          {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} workflows
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

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow</AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes <strong>{deleteTarget?.name}</strong> — the workflow becomes
              inactive and is hidden from default lists, but its definition and execution history
              are preserved. You can reactivate it by flipping its status switch back on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-destructive text-sm">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-red-600 hover:bg-red-700"
              disabled={isLoading}
            >
              {isLoading ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
