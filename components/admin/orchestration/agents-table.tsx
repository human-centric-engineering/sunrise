'use client';

/**
 * AgentsTable (Phase 4 Session 4.2)
 *
 * Admin list view for AI agents. Modelled on `components/admin/user-table.tsx`
 * with four additions specific to orchestration:
 *
 *   1. Bulk selection checkboxes + an Export Selected header button that
 *      POSTs `/agents/export` and triggers a file download.
 *   2. Per-row status Switch that optimistically PATCHes `isActive` and
 *      reverts on failure with an inline error.
 *   3. Per-row Month-to-Date spend column that fetches
 *      `GET /agents/:id/budget` *after* paint — list render is never
 *      blocked on N budget calls. Fallback is an em-dash.
 *   4. Row dropdown menu — Edit, Duplicate (opens dialog), Delete
 *      (soft-deletes via DELETE `/agents/:id`).
 *
 * Delete uses the same inline AlertDialog pattern as UserTable.
 */

import type { AiAgent } from '@/types/orchestration';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Edit,
  FileUp,
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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Tip } from '@/components/ui/tooltip';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';
import { DuplicateAgentDialog } from '@/components/admin/orchestration/duplicate-agent-dialog';
import { ImportAgentsDialog } from '@/components/admin/orchestration/import-agents-dialog';

export interface AgentsTableProps {
  initialAgents: AiAgent[];
  initialMeta: PaginationMeta;
}

type SortField = 'createdAt' | 'name';

interface BudgetEntry {
  spent: number;
  limit: number | null;
  withinBudget: boolean;
}

export function AgentsTable({ initialAgents, initialMeta }: AgentsTableProps) {
  const router = useRouter();
  const [agents, setAgents] = useState(initialAgents);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [isLoading, setIsLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AiAgent | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [duplicateSource, setDuplicateSource] = useState<AiAgent | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [budgets, setBudgets] = useState<Record<string, BudgetEntry | null>>({});
  const [capCounts, setCapCounts] = useState<Record<string, number | null>>({});
  const [convCounts, setConvCounts] = useState<Record<string, number | null>>({});
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  /**
   * Fetch the page of agents with current filters. On failure, keeps the
   * existing list but surfaces an inline banner.
   */
  const fetchAgents = useCallback(
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

        const res = await fetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('list failed');

        const body = await parseApiResponse<AiAgent[]>(res);
        if (!body.success) throw new Error('list failed');

        const next = [...body.data];
        // Client-side sort — Phase 3 list is createdAt desc only.
        const field = overrides?.sortField ?? sortField;
        const order = overrides?.sortOrder ?? sortOrder;
        next.sort((a, b) => {
          const av = field === 'name' ? a.name.toLowerCase() : new Date(a.createdAt).getTime();
          const bv = field === 'name' ? b.name.toLowerCase() : new Date(b.createdAt).getTime();
          if (av < bv) return order === 'asc' ? -1 : 1;
          if (av > bv) return order === 'asc' ? 1 : -1;
          return 0;
        });
        setAgents(next);

        const parsedMeta = parsePaginationMeta(body.meta);
        if (parsedMeta) setMeta(parsedMeta);
        setSelected(new Set()); // Clear selection on page change / refetch
      } catch {
        setListError('Could not load agents. Try refreshing the page.');
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit, search, sortField, sortOrder]
  );

  /**
   * Lazy-fetch MTD spend for every visible row once the list paints.
   */
  useEffect(() => {
    if (agents.length === 0) return;
    let cancelled = false;

    void (async () => {
      const entries = await Promise.all(
        agents.map(async (agent): Promise<[string, BudgetEntry | null]> => {
          try {
            const res = await fetch(API.ADMIN.ORCHESTRATION.agentBudget(agent.id), {
              credentials: 'same-origin',
            });
            if (!res.ok) return [agent.id, null];
            const body = await parseApiResponse<BudgetEntry>(res);
            return [agent.id, body.success ? body.data : null];
          } catch {
            return [agent.id, null];
          }
        })
      );
      if (cancelled) return;
      setBudgets(Object.fromEntries(entries));
    })();

    return () => {
      cancelled = true;
    };
  }, [agents]);

  // Lazy-fetch capability count per visible row.
  useEffect(() => {
    if (agents.length === 0) return;
    let cancelled = false;

    void (async () => {
      const entries = await Promise.all(
        agents.map(async (agent): Promise<[string, number | null]> => {
          try {
            const res = await fetch(API.ADMIN.ORCHESTRATION.agentCapabilities(agent.id), {
              credentials: 'same-origin',
            });
            if (!res.ok) return [agent.id, null];
            const body = await parseApiResponse<unknown[]>(res);
            return [agent.id, body.success ? body.data.length : null];
          } catch {
            return [agent.id, null];
          }
        })
      );
      if (cancelled) return;
      setCapCounts(Object.fromEntries(entries));
    })();

    return () => {
      cancelled = true;
    };
  }, [agents]);

  // Lazy-fetch conversation count per visible row.
  useEffect(() => {
    if (agents.length === 0) return;
    let cancelled = false;

    void (async () => {
      const entries = await Promise.all(
        agents.map(async (agent): Promise<[string, number | null]> => {
          try {
            const res = await fetch(
              `${API.ADMIN.ORCHESTRATION.CONVERSATIONS}?agentId=${agent.id}&limit=1&page=1`,
              { credentials: 'same-origin' }
            );
            if (!res.ok) return [agent.id, null];
            const body = await parseApiResponse<unknown[]>(res);
            if (!body.success) return [agent.id, null];
            const meta = parsePaginationMeta(body.meta);
            return [agent.id, meta?.total ?? null];
          } catch {
            return [agent.id, null];
          }
        })
      );
      if (cancelled) return;
      setConvCounts(Object.fromEntries(entries));
    })();

    return () => {
      cancelled = true;
    };
  }, [agents]);

  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        void fetchAgents(1, { search: value });
      }, 300);
    },
    [fetchAgents]
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const nextOrder: 'asc' | 'desc' =
        sortField === field ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'desc';
      setSortField(field);
      setSortOrder(nextOrder);
      void fetchAgents(meta.page, { sortField: field, sortOrder: nextOrder });
    },
    [fetchAgents, meta.page, sortField, sortOrder]
  );

  const handlePage = useCallback(
    (page: number) => {
      void fetchAgents(page);
    },
    [fetchAgents]
  );

  /**
   * Optimistic status toggle — flips the local row first, then PATCHes.
   * On failure, reverts.
   */
  const handleToggleStatus = useCallback(async (agent: AiAgent, nextActive: boolean) => {
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, isActive: nextActive } : a)));
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.agentById(agent.id), {
        body: { isActive: nextActive },
      });
    } catch (err) {
      // Revert
      setAgents((prev) =>
        prev.map((a) => (a.id === agent.id ? { ...a, isActive: agent.isActive } : a))
      );
      setListError(
        err instanceof APIClientError
          ? `Couldn't update "${agent.name}": ${err.message}`
          : `Couldn't update "${agent.name}". Try again.`
      );
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setIsLoading(true);
    setDeleteError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.agentById(deleteTarget.id));
      setDeleteTarget(null);
      void fetchAgents(meta.page);
    } catch (err) {
      setDeleteError(
        err instanceof APIClientError ? err.message : 'Delete failed. Try again in a moment.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [deleteTarget, fetchAgents, meta.page]);

  const handleExportSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setListError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.AGENTS_EXPORT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentIds: [...selected] }),
      });
      if (!res.ok) throw new Error('export failed');

      // Prefer the server-supplied filename, fall back to a timestamped default.
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? `agents-${new Date().toISOString().slice(0, 10)}.json`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setListError('Export failed. Try again in a moment.');
    }
  }, [selected]);

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === agents.length) return new Set();
      return new Set(agents.map((a) => a.id));
    });
  }, [agents]);

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="ml-2 h-4 w-4" />;
    return sortOrder === 'asc' ? (
      <ArrowUp className="ml-2 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-2 h-4 w-4" />
    );
  };

  const allSelected = agents.length > 0 && selected.size === agents.length;

  return (
    <div className="space-y-4">
      {/* Header / toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder="Search agents..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
            title="Upload a JSON bundle to create agents from another Sunrise instance"
          >
            <FileUp className="mr-2 h-4 w-4" />
            Import
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExportSelected()}
            disabled={selected.size === 0}
            title="Download the selected agents as a portable JSON bundle — includes config, instructions, and capability links (no secrets)"
          >
            <Download className="mr-2 h-4 w-4" />
            Export selected ({selected.size})
          </Button>
          <Button asChild size="sm">
            <Link href="/admin/orchestration/agents/new">
              <Plus className="mr-2 h-4 w-4" />
              Create agent
            </Link>
          </Button>
        </div>
      </div>

      {listError && (
        <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {listError}
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => toggleAll()}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead>
                <Tip label="Sort by agent name">
                  <Button variant="ghost" className="-ml-4 h-8" onClick={() => handleSort('name')}>
                    Name
                    {renderSortIcon('name')}
                  </Button>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="URL-safe identifier used in API calls and URLs">
                  <span>Slug</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Number of capabilities (tools) attached to this agent">
                  <span>Caps</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Total conversations this agent has participated in">
                  <span>Convs</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="The LLM service powering this agent (e.g. Anthropic, OpenAI, Ollama)">
                  <span>Provider</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="The specific model this agent uses for chat responses">
                  <span>Model</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Temperature — controls response creativity (0 = deterministic, 2 = most creative)">
                  <span>Temp</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Monthly budget cap in USD — blank means no limit">
                  <span>Budget</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Spend month-to-date — total LLM cost this calendar month (UTC)">
                  <span>Spend MTD</span>
                </Tip>
              </TableHead>
              <TableHead className="text-center">
                <Tip label="Whether this agent is active and available for chat">
                  <span>Status</span>
                </Tip>
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && agents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="h-24 text-center">
                  Loading…
                </TableCell>
              </TableRow>
            ) : agents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="h-24 text-center">
                  No agents found.
                </TableCell>
              </TableRow>
            ) : (
              agents.map((agent) => {
                const budget = budgets[agent.id];
                return (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(agent.id)}
                        onCheckedChange={() => toggleRow(agent.id)}
                        aria-label={`Select ${agent.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/orchestration/agents/${agent.id}`}
                        className="hover:underline"
                      >
                        {agent.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {agent.slug}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {capCounts[agent.id] === undefined ? (
                        <span className="text-muted-foreground">…</span>
                      ) : capCounts[agent.id] === null ? (
                        '—'
                      ) : capCounts[agent.id] === 0 ? (
                        <span className="text-muted-foreground">0</span>
                      ) : (
                        <Link
                          href={`/admin/orchestration/agents/${agent.id}`}
                          className="hover:underline"
                          title="View agent capabilities"
                        >
                          {capCounts[agent.id]}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {convCounts[agent.id] === undefined ? (
                        <span className="text-muted-foreground">…</span>
                      ) : convCounts[agent.id] === null ? (
                        '—'
                      ) : (
                        convCounts[agent.id]
                      )}
                    </TableCell>
                    <TableCell>{agent.provider}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{agent.model}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {agent.temperature.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {agent.monthlyBudgetUsd ? `$${agent.monthlyBudgetUsd.toFixed(2)}` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {budget === undefined ? (
                        <span className="text-muted-foreground">…</span>
                      ) : budget === null ? (
                        '—'
                      ) : (
                        `$${budget.spent.toFixed(2)}`
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={agent.isActive}
                        onCheckedChange={(v) => void handleToggleStatus(agent, v)}
                        aria-label={`Toggle ${agent.name} active`}
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
                            onClick={() => router.push(`/admin/orchestration/agents/${agent.id}`)}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDuplicateSource(agent)}>
                            <Copy className="mr-2 h-4 w-4" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600"
                            onClick={() => setDeleteTarget(agent)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
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

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Showing {agents.length === 0 ? 0 : (meta.page - 1) * meta.limit + 1} to{' '}
          {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} agents
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

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent</AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes <strong>{deleteTarget?.name}</strong> — the agent becomes inactive
              and is hidden from default lists, but its history (conversations, cost logs) is
              preserved. You can reactivate it by flipping its status back on.
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

      {/* Duplicate dialog */}
      <DuplicateAgentDialog
        source={duplicateSource}
        onOpenChange={(open) => {
          if (!open) setDuplicateSource(null);
        }}
      />

      {/* Import dialog */}
      <ImportAgentsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => void fetchAgents(1)}
      />
    </div>
  );
}
