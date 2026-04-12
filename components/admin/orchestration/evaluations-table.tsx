'use client';

/**
 * EvaluationsTable (Phase 7 Session 7.1)
 *
 * Admin list view for AI evaluation sessions. Supports:
 *   - Title search (300ms debounce)
 *   - Agent filter dropdown
 *   - Status filter dropdown (draft / in_progress / completed / archived)
 *   - Pagination (prev/next)
 *   - "New Evaluation" link
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import type { PaginationMeta } from '@/types/api';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EvaluationListItem {
  id: string;
  title: string;
  status: string;
  description?: string | null;
  agentId?: string | null;
  agent?: { id: string; name: string; slug: string } | null;
  _count?: { logs: number };
  createdAt: string;
}

interface AgentOption {
  id: string;
  name: string;
}

export interface EvaluationsTableProps {
  initialEvaluations: EvaluationListItem[];
  initialMeta: PaginationMeta;
  agents: AgentOption[];
}

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
] as const;

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'completed':
      return 'default';
    case 'in_progress':
      return 'secondary';
    case 'archived':
      return 'outline';
    default:
      return 'outline';
  }
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Component ──────────────────────────────────────────────────────────────

export function EvaluationsTable({
  initialEvaluations,
  initialMeta,
  agents,
}: EvaluationsTableProps) {
  const [evaluations, setEvaluations] = useState(initialEvaluations);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const fetchEvaluations = useCallback(
    async (page = 1, overrides?: { search?: string; agentId?: string; status?: string }) => {
      setIsLoading(true);
      setListError(null);
      try {
        const searchValue = overrides?.search !== undefined ? overrides.search : search;
        const agentValue = overrides?.agentId !== undefined ? overrides.agentId : agentFilter;
        const statusValue = overrides?.status !== undefined ? overrides.status : statusFilter;

        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
        });
        if (searchValue) params.set('q', searchValue);
        if (agentValue && agentValue !== 'all') params.set('agentId', agentValue);
        if (statusValue && statusValue !== 'all') params.set('status', statusValue);

        const res = await fetch(`${API.ADMIN.ORCHESTRATION.EVALUATIONS}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('list failed');

        const body = await parseApiResponse<EvaluationListItem[]>(res);
        if (!body.success) throw new Error('list failed');

        setEvaluations(body.data);
        const parsedMeta = parsePaginationMeta(body.meta);
        if (parsedMeta) setMeta(parsedMeta);
      } catch {
        setListError('Could not load evaluations. Try refreshing the page.');
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit, search, agentFilter, statusFilter]
  );

  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        void fetchEvaluations(1, { search: value });
      }, 300);
    },
    [fetchEvaluations]
  );

  const handleAgentFilter = useCallback(
    (value: string) => {
      setAgentFilter(value);
      void fetchEvaluations(1, { agentId: value });
    },
    [fetchEvaluations]
  );

  const handleStatusFilter = useCallback(
    (value: string) => {
      setStatusFilter(value);
      void fetchEvaluations(1, { status: value });
    },
    [fetchEvaluations]
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-3">
          <div className="relative max-w-xs flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 h-4 w-4" />
            <Input
              placeholder="Search evaluations…"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={agentFilter} onValueChange={handleAgentFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={handleStatusFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button asChild>
          <Link href="/admin/orchestration/evaluations/new">
            <Plus className="mr-2 h-4 w-4" />
            New Evaluation
          </Link>
        </Button>
      </div>

      {/* Error banner */}
      {listError && (
        <div className="bg-destructive/5 text-destructive rounded-md px-4 py-3 text-sm">
          {listError}
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Logs</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {evaluations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground h-24 text-center">
                  {isLoading ? 'Loading…' : 'No evaluations found.'}
                </TableCell>
              </TableRow>
            ) : (
              evaluations.map((ev) => (
                <TableRow key={ev.id}>
                  <TableCell>
                    <Link
                      href={`/admin/orchestration/evaluations/${ev.id}`}
                      className="font-medium hover:underline"
                    >
                      {ev.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{ev.agent?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(ev.status)}>{formatStatus(ev.status)}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{ev._count?.logs ?? 0}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(ev.createdAt).toLocaleDateString()}
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
          Page {meta.page} of {meta.totalPages} ({meta.total} total)
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={meta.page <= 1 || isLoading}
            onClick={() => void fetchEvaluations(meta.page - 1)}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={meta.page >= meta.totalPages || isLoading}
            onClick={() => void fetchEvaluations(meta.page + 1)}
          >
            Next
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
