'use client';

/**
 * CapabilitiesTable (Phase 4 Session 4.3)
 *
 * Admin list view for `AiCapability`. Mirrors `agents-table.tsx` structure
 * with four deltas:
 *
 *   1. Category filter dropdown — server-side via `?category=`.
 *   2. Execution-type badge + requires-approval badge.
 *   3. Lazy "agents using it" count per row via
 *      `GET /capabilities/:id/agents`. Failures render an em-dash.
 *   4. Per-row status Switch with optimistic PATCH revert pattern.
 *
 * No bulk select / export — capabilities bundle with agents via agent
 * export/import, so there is no standalone bundle format today.
 */

import type { AiCapabilityListItem } from '@/types/orchestration';
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

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DeleteCapabilityDialog } from '@/components/admin/orchestration/delete-capability-dialog';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';

export interface CapabilitiesTableProps {
  initialCapabilities: AiCapabilityListItem[];
  initialMeta: PaginationMeta;
  availableCategories: string[];
}

type SortField = 'name' | 'category';

const ALL_CATEGORIES = '__all__';

function ExecutionTypeBadge({ type }: { type: string }) {
  const classes =
    type === 'internal'
      ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30'
      : type === 'api'
        ? 'bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/30'
        : 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30';
  return (
    <Badge variant="outline" className={classes}>
      {type}
    </Badge>
  );
}

export function CapabilitiesTable({
  initialCapabilities,
  initialMeta,
  availableCategories,
}: CapabilitiesTableProps) {
  const router = useRouter();
  const [capabilities, setCapabilities] = useState(initialCapabilities);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [isLoading, setIsLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AiCapabilityListItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const fetchCapabilities = useCallback(
    async (
      page = 1,
      overrides?: {
        search?: string;
        category?: string;
        sortField?: SortField;
        sortOrder?: 'asc' | 'desc';
      }
    ) => {
      setIsLoading(true);
      setListError(null);
      try {
        const searchValue = overrides?.search !== undefined ? overrides.search : search;
        const categoryValue = overrides?.category !== undefined ? overrides.category : category;

        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
        });
        if (searchValue) params.set('q', searchValue);
        if (categoryValue && categoryValue !== ALL_CATEGORIES) {
          params.set('category', categoryValue);
        }

        const res = await fetch(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('list failed');

        const body = await parseApiResponse<AiCapabilityListItem[]>(res);
        if (!body.success) throw new Error('list failed');

        const next = [...body.data];
        const field = overrides?.sortField ?? sortField;
        const order = overrides?.sortOrder ?? sortOrder;
        next.sort((a, b) => {
          const av = field === 'name' ? a.name.toLowerCase() : a.category.toLowerCase();
          const bv = field === 'name' ? b.name.toLowerCase() : b.category.toLowerCase();
          if (av < bv) return order === 'asc' ? -1 : 1;
          if (av > bv) return order === 'asc' ? 1 : -1;
          return 0;
        });
        setCapabilities(next);

        const parsedMeta = parsePaginationMeta(body.meta);
        if (parsedMeta) setMeta(parsedMeta);
      } catch {
        setListError('Could not load capabilities. Try refreshing the page.');
      } finally {
        setIsLoading(false);
      }
    },
    [category, meta.limit, search, sortField, sortOrder]
  );

  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        void fetchCapabilities(1, { search: value });
      }, 300);
    },
    [fetchCapabilities]
  );

  const handleCategoryChange = useCallback(
    (value: string) => {
      setCategory(value);
      void fetchCapabilities(1, { category: value });
    },
    [fetchCapabilities]
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const nextOrder: 'asc' | 'desc' =
        sortField === field ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'desc';
      setSortField(field);
      setSortOrder(nextOrder);
      void fetchCapabilities(meta.page, { sortField: field, sortOrder: nextOrder });
    },
    [fetchCapabilities, meta.page, sortField, sortOrder]
  );

  const handlePage = useCallback(
    (page: number) => {
      void fetchCapabilities(page);
    },
    [fetchCapabilities]
  );

  const handleToggleStatus = useCallback(async (cap: AiCapabilityListItem, nextActive: boolean) => {
    setCapabilities((prev) =>
      prev.map((c) => (c.id === cap.id ? { ...c, isActive: nextActive } : c))
    );
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.capabilityById(cap.id), {
        body: { isActive: nextActive },
      });
    } catch (err) {
      setCapabilities((prev) =>
        prev.map((c) => (c.id === cap.id ? { ...c, isActive: cap.isActive } : c))
      );
      setListError(
        err instanceof APIClientError
          ? `Couldn't update "${cap.name}": ${err.message}`
          : `Couldn't update "${cap.name}". Try again.`
      );
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setIsLoading(true);
    setDeleteError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.capabilityById(deleteTarget.id));
      setDeleteTarget(null);
      void fetchCapabilities(meta.page);
    } catch (err) {
      setDeleteError(
        err instanceof APIClientError ? err.message : 'Delete failed. Try again in a moment.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [deleteTarget, fetchCapabilities, meta.page]);

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
      {/* Header / toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative max-w-sm flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              placeholder="Search capabilities..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={category} onValueChange={handleCategoryChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {availableCategories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/orchestration/capabilities/new">
            <Plus className="mr-2 h-4 w-4" />
            New capability
          </Link>
        </Button>
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
              <TableHead>
                <Tip label="Sort by capability name">
                  <Button variant="ghost" className="-ml-4 h-8" onClick={() => handleSort('name')}>
                    Name
                    {renderSortIcon('name')}
                  </Button>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Grouping category for organising capabilities (e.g. api, search, comms)">
                  <span>Category</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="How the capability runs: internal (TypeScript handler), api (HTTP POST), or webhook (fire-and-forget)">
                  <span>Exec type</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="When set, a human must approve each call before it executes — use for high-risk actions">
                  <span>Approval</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Maximum calls per minute across all agents — blank means no limit">
                  <span>Rate/min</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Number of agents that have this capability attached">
                  <span>Agents</span>
                </Tip>
              </TableHead>
              <TableHead className="text-center">
                <Tip label="Whether this capability is active and available for agents to call">
                  <span>Status</span>
                </Tip>
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && capabilities.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  Loading…
                </TableCell>
              </TableRow>
            ) : capabilities.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  No capabilities found.
                </TableCell>
              </TableRow>
            ) : (
              capabilities.map((cap) => (
                <TableRow key={cap.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/orchestration/capabilities/${cap.id}`}
                      className="hover:underline"
                    >
                      {cap.name}
                    </Link>
                    <div className="text-muted-foreground font-mono text-xs">{cap.slug}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{cap.category}</Badge>
                  </TableCell>
                  <TableCell>
                    <ExecutionTypeBadge type={cap.executionType} />
                  </TableCell>
                  <TableCell>
                    {cap.requiresApproval ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      >
                        Approval
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{cap.rateLimit ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {cap._agents.length === 0 ? (
                      '0'
                    ) : (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button className="cursor-pointer tabular-nums hover:underline">
                            {cap._agents.length} →
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64 p-0" align="end">
                          <div className="border-b px-3 py-2">
                            <p className="text-sm font-medium">
                              {cap._agents.length} agent{cap._agents.length !== 1 ? 's' : ''} using{' '}
                              <span className="font-semibold">{cap.name}</span>
                            </p>
                          </div>
                          <ul className="max-h-48 overflow-y-auto py-1">
                            {cap._agents.map((agent) => (
                              <li key={agent.id}>
                                <Link
                                  href={`/admin/orchestration/agents/${agent.id}`}
                                  className="hover:bg-muted flex items-center gap-2 px-3 py-1.5 text-sm transition-colors"
                                >
                                  <span className="truncate">{agent.name}</span>
                                  <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
                                    {agent.slug}
                                  </span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </PopoverContent>
                      </Popover>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={cap.isActive}
                      onCheckedChange={(v) => void handleToggleStatus(cap, v)}
                      aria-label={`Toggle ${cap.name} active`}
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
                          onClick={() => router.push(`/admin/orchestration/capabilities/${cap.id}`)}
                        >
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => setDeleteTarget(cap)}
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

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Showing {capabilities.length === 0 ? 0 : (meta.page - 1) * meta.limit + 1} to{' '}
          {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} capabilities
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

      <DeleteCapabilityDialog
        target={deleteTarget}
        usedBy={deleteTarget?._agents ?? []}
        error={deleteError}
        isDeleting={isLoading}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
