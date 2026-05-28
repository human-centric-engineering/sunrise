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

import type { AiAgentListItem } from '@/types/orchestration';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowLeftRight,
  Copy,
  Download,
  Edit,
  Eye,
  FileUp,
  FolderTree,
  Layers,
  Link2,
  Loader2,
  MoreHorizontal,
  Plus,
  Power,
  PowerOff,
  Scale,
  Search,
  Shield,
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
import { Badge } from '@/components/ui/badge';
import { Tip } from '@/components/ui/tooltip';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import type { PaginationMeta } from '@/types/api';
import type { AiAgent } from '@/types/orchestration';
import { DuplicateAgentDialog } from '@/components/admin/orchestration/duplicate-agent-dialog';
import { ImportAgentsDialog } from '@/components/admin/orchestration/import-agents-dialog';

const VISIBILITY_BADGE: Record<string, { label: string; icon: React.ReactNode } | null> = {
  internal: null,
  public: { label: 'Public', icon: <Eye className="h-3 w-3" /> },
  invite_only: { label: 'Invite', icon: <Link2 className="h-3 w-3" /> },
};

export interface AgentsTableProps {
  initialAgents: AiAgentListItem[];
  initialMeta: PaginationMeta;
}

type SortField = 'createdAt' | 'name' | 'lastActiveAt';
type ProfileOption = { id: string; name: string; isSystem: boolean };
const PROFILE_FILTER_ALL = '__all__';
const PROFILE_FILTER_UNASSIGNED = 'none';

export function AgentsTable({ initialAgents, initialMeta }: AgentsTableProps) {
  const router = useRouter();
  const [agents, setAgents] = useState(initialAgents);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState('');
  // 'default' = the server's natural-importance order (bespoke first, then
  // lastActiveAt desc, then createdAt desc). Clicking a column header sets
  // an explicit sort that overrides the default.
  const [sortField, setSortField] = useState<SortField | 'default'>('default');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [profileFilter, setProfileFilter] = useState<string>(PROFILE_FILTER_ALL);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [groupByProfile, setGroupByProfile] = useLocalStorage(
    'agents-table-group-by-profile',
    false
  );
  const [collapsedBuckets, setCollapsedBuckets] = useLocalStorage<Record<string, boolean>>(
    'agents-table-collapsed-buckets',
    {}
  );
  const [isLoading, setIsLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AiAgentListItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [duplicateSource, setDuplicateSource] = useState<AiAgent | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Profile dropdown options — fetched once on mount. Failure is silent;
  // the dropdown just stays at "All profiles".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API.ADMIN.ORCHESTRATION.AGENT_PROFILES}?limit=200`, {
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const body =
          await parseApiResponse<Array<{ id: string; name: string; isSystem: boolean }>>(res);
        if (!cancelled && body.success) {
          setProfiles(body.data.map((p) => ({ id: p.id, name: p.name, isSystem: p.isSystem })));
        }
      } catch {
        // Silent — dropdown falls back to "All profiles" only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      overrides?: {
        search?: string;
        sortField?: SortField | 'default';
        sortOrder?: 'asc' | 'desc';
        profileFilter?: string;
      }
    ) => {
      setIsLoading(true);
      setListError(null);
      try {
        const searchValue = overrides?.search !== undefined ? overrides.search : search;
        const profileValue =
          overrides?.profileFilter !== undefined ? overrides.profileFilter : profileFilter;
        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
        });
        if (searchValue) params.set('q', searchValue);
        if (profileValue && profileValue !== PROFILE_FILTER_ALL) {
          params.set('profileId', profileValue);
        }

        const res = await fetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('list failed');

        const body = await parseApiResponse<AiAgentListItem[]>(res);
        if (!body.success) throw new Error('list failed');

        // Server already returns the right order:
        //   [isSystem asc, lastActiveAt desc nulls last, createdAt desc].
        // If the user clicks a header, do a single-pass re-sort that
        // PRESERVES the bespoke-first split — system agents stay below
        // bespoke agents regardless of which column they clicked.
        const field = overrides?.sortField ?? sortField;
        const order = overrides?.sortOrder ?? sortOrder;
        const next = [...body.data];
        if (field !== 'default') {
          next.sort((a, b) => {
            if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
            let av: number | string;
            let bv: number | string;
            if (field === 'name') {
              av = a.name.toLowerCase();
              bv = b.name.toLowerCase();
            } else if (field === 'lastActiveAt') {
              // Nulls last regardless of sort direction.
              av = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : -Infinity;
              bv = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : -Infinity;
            } else {
              av = new Date(a.createdAt).getTime();
              bv = new Date(b.createdAt).getTime();
            }
            if (av < bv) return order === 'asc' ? -1 : 1;
            if (av > bv) return order === 'asc' ? 1 : -1;
            return 0;
          });
        }
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
    [meta.limit, search, sortField, sortOrder, profileFilter]
  );

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
      void fetchAgents(1, { sortField: field, sortOrder: nextOrder });
    },
    [fetchAgents, sortField, sortOrder]
  );

  const handleProfileFilterChange = useCallback(
    (value: string) => {
      setProfileFilter(value);
      void fetchAgents(1, { profileFilter: value });
    },
    [fetchAgents]
  );

  const toggleBucket = useCallback(
    (bucketId: string) => {
      setCollapsedBuckets((prev) => ({ ...prev, [bucketId]: !prev[bucketId] }));
    },
    [setCollapsedBuckets]
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
  const handleToggleStatus = useCallback(async (agent: AiAgentListItem, nextActive: boolean) => {
    const previousActive = !nextActive; // the state we're flipping away from
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, isActive: nextActive } : a)));
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.agentById(agent.id), {
        body: { isActive: nextActive },
      });
    } catch (err) {
      // Revert to the state before this specific toggle, not from a stale closure
      setAgents((prev) =>
        prev.map((a) => (a.id === agent.id ? { ...a, isActive: previousActive } : a))
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

  const [bulkAction, setBulkAction] = useState<string | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const handleBulkAction = useCallback(
    async (action: 'activate' | 'deactivate' | 'delete') => {
      if (selected.size === 0) return;
      setBulkAction(action);
      setListError(null);
      try {
        await apiClient.post(API.ADMIN.ORCHESTRATION.AGENTS_BULK, {
          body: { action, agentIds: [...selected] },
        });
        void fetchAgents(meta.page);
      } catch (err) {
        setListError(
          err instanceof APIClientError
            ? `Bulk ${action} failed: ${err.message}`
            : `Bulk ${action} failed. Try again in a moment.`
        );
      } finally {
        setBulkAction(null);
        setBulkDeleteOpen(false);
      }
    },
    [selected, fetchAgents, meta.page]
  );

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

  // Bucket the current page by profile when group-by-profile is on.
  // Buckets render in the order they're produced by the server sort, so
  // the bespoke-first / recently-active default still drives placement.
  // Returns `null` when grouping is off — the renderer falls back to flat
  // table mode.
  type Bucket = {
    id: string;
    label: string;
    isSystemProfile: boolean;
    isUnassigned: boolean;
    agents: AiAgentListItem[];
  };
  const buckets: Bucket[] | null = (() => {
    if (!groupByProfile) return null;
    const byId = new Map<string, Bucket>();
    const order: string[] = [];
    for (const a of agents) {
      const key = a.profile?.id ?? '__unassigned__';
      if (!byId.has(key)) {
        byId.set(key, {
          id: key,
          label: a.profile?.name ?? 'Unassigned',
          isSystemProfile: a.profile?.isSystem ?? false,
          isUnassigned: a.profile === null,
          agents: [],
        });
        order.push(key);
      }
      byId.get(key)!.agents.push(a);
    }
    // Reorder buckets so "Unassigned" sinks to the bottom — everything
    // else keeps the natural ordering produced by the server sort.
    const unassigned = order.filter((k) => k === '__unassigned__');
    const assigned = order.filter((k) => k !== '__unassigned__');
    return [...assigned, ...unassigned].map((k) => byId.get(k)!);
  })();

  function formatRelativeTime(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    const diffMonths = Math.floor(diffDays / 30);
    return `${diffMonths}mo ago`;
  }

  function renderAgentRow(agent: AiAgentListItem) {
    const visBadge = VISIBILITY_BADGE[agent.visibility] ?? null;
    return (
      <TableRow key={agent.id}>
        <TableCell>
          <Checkbox
            checked={selected.has(agent.id)}
            onCheckedChange={() => toggleRow(agent.id)}
            aria-label={`Select ${agent.name}`}
          />
        </TableCell>
        <TableCell className="max-w-[280px]">
          <div className="flex items-center gap-2">
            <Link
              href={`/admin/orchestration/agents/${agent.id}`}
              className="font-medium hover:underline"
            >
              {agent.name}
            </Link>
            {agent.isSystem && (
              <Tip label="System agent — used internally by the platform. Cannot be deleted or deactivated.">
                <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px] font-medium">
                  <Shield className="h-3 w-3" />
                  System
                </Badge>
              </Tip>
            )}
            {agent.kind === 'judge' && (
              <Tip label="Judge agent — driven by the evaluation worker (and the manual-session scorer) to score AI responses. Edit the system instructions to change its rubric.">
                <Badge
                  variant="outline"
                  className="gap-1 border-amber-300 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:border-amber-700 dark:text-amber-300"
                >
                  <Scale className="h-3 w-3" />
                  Judge
                </Badge>
              </Tip>
            )}
            {visBadge && (
              <Tip label={`Visibility: ${agent.visibility.replace('_', ' ')}`}>
                <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-medium">
                  {visBadge.icon}
                  {visBadge.label}
                </Badge>
              </Tip>
            )}
          </div>
          {agent.description && (
            <p className="text-muted-foreground mt-0.5 truncate text-xs">{agent.description}</p>
          )}
        </TableCell>
        <TableCell className="text-xs">
          {agent.profile ? (
            <Tip
              label={
                agent.profile.isSystem
                  ? `System profile "${agent.profile.name}" — open to view persona, voice, and guardrails`
                  : `Profile "${agent.profile.name}" — open to edit persona, voice, and guardrails`
              }
            >
              <Link
                href={`/admin/orchestration/agent-profiles/${agent.profile.id}`}
                className="inline-flex"
              >
                <Badge
                  variant="outline"
                  className="hover:bg-muted gap-1 px-1.5 py-0 text-[10px] font-medium"
                >
                  {agent.profile.isSystem && <Shield className="h-3 w-3" aria-hidden="true" />}
                  {agent.profile.name}
                </Badge>
              </Link>
            </Tip>
          ) : (
            <Tip label="No profile — agent's own persona/voice/guardrails apply directly">
              <span className="text-muted-foreground">—</span>
            </Tip>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {agent._count.capabilities === 0 ? (
            <span className="text-muted-foreground">0</span>
          ) : (
            <Link
              href={`/admin/orchestration/agents/${agent.id}`}
              className="hover:underline"
              title="View agent tools"
            >
              {agent._count.capabilities}
            </Link>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">{agent._count.conversations}</TableCell>
        <TableCell className="text-xs">
          {agent.provider === '' && agent.model === '' ? (
            <Tip label="At runtime this agent uses the first active provider plus the default chat model from Orchestration Settings. Set the default chat model on the Settings page (Default models card) or via the setup wizard's 'Default models' step.">
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
                System default
              </Badge>
            </Tip>
          ) : (
            <>
              <span className="text-muted-foreground">{agent.provider} /</span> {agent.model}
            </>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {agent.monthlyBudgetUsd ? (
            `$${agent.monthlyBudgetUsd.toFixed(2)}`
          ) : (
            <Tip label="No budget cap set">
              <span className="text-muted-foreground">—</span>
            </Tip>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {agent._budget ? (
            `$${agent._budget.spent.toFixed(2)}`
          ) : (
            <Tip label="Spend data not available">
              <span className="text-muted-foreground">—</span>
            </Tip>
          )}
        </TableCell>
        <TableCell className="text-xs">
          {agent.lastActiveAt ? (
            <Tip label={new Date(agent.lastActiveAt).toLocaleString()}>
              <span className="text-muted-foreground">
                {formatRelativeTime(agent.lastActiveAt)}
              </span>
            </Tip>
          ) : (
            <Tip label="No activity yet — never used in a conversation or LLM call">
              <span className="text-muted-foreground">Never</span>
            </Tip>
          )}
        </TableCell>
        <TableCell className="text-xs">
          <Tip label={agent.creator?.name ? `Created by ${agent.creator.name}` : 'Creator unknown'}>
            <span className="text-muted-foreground">{formatRelativeTime(agent.createdAt)}</span>
          </Tip>
        </TableCell>
        <TableCell className="text-center">
          {agent.isSystem ? (
            <Tip label="System agents cannot be deactivated">
              <span className="inline-block">
                <Switch
                  checked={agent.isActive}
                  disabled
                  aria-label={`${agent.name} is a system agent and cannot be deactivated`}
                />
              </span>
            </Tip>
          ) : (
            <Switch
              checked={agent.isActive}
              onCheckedChange={(v) => void handleToggleStatus(agent, v)}
              aria-label={`Toggle ${agent.name} active`}
            />
          )}
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
              {!agent.isSystem && (
                <DropdownMenuItem className="text-red-600" onClick={() => setDeleteTarget(agent)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header / toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              placeholder="Search agents..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Tip label="Filter by agent profile — the inheritable persona/voice/guardrails library each agent can link to">
            <Select value={profileFilter} onValueChange={handleProfileFilterChange}>
              <SelectTrigger className="h-9 w-[200px]" aria-label="Filter by profile">
                <FolderTree className="text-muted-foreground mr-1 h-4 w-4" />
                <SelectValue placeholder="All profiles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROFILE_FILTER_ALL}>All profiles</SelectItem>
                <SelectItem value={PROFILE_FILTER_UNASSIGNED}>Unassigned</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-1.5">
                      {p.isSystem && (
                        <Shield className="text-muted-foreground h-3 w-3" aria-hidden="true" />
                      )}
                      {p.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Tip>
          <Tip label="Group rows by profile — collapsible sections, current page only">
            <Button
              variant={groupByProfile ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupByProfile((v) => !v)}
              aria-pressed={groupByProfile}
              aria-label="Toggle group by profile"
            >
              <Layers className="mr-2 h-4 w-4" />
              Group
            </Button>
          </Tip>
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
          {selected.size === 2 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const ids = Array.from(selected);
                router.push(`/admin/orchestration/agents/compare?a=${ids[0]}&b=${ids[1]}`);
              }}
            >
              <ArrowLeftRight className="mr-2 h-4 w-4" />
              Compare
            </Button>
          )}
          {selected.size > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleBulkAction('activate')}
                disabled={!!bulkAction}
              >
                {bulkAction === 'activate' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Power className="mr-2 h-4 w-4" />
                )}
                Activate
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleBulkAction('deactivate')}
                disabled={!!bulkAction}
              >
                {bulkAction === 'deactivate' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <PowerOff className="mr-2 h-4 w-4" />
                )}
                Deactivate
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
                disabled={!!bulkAction}
              >
                {bulkAction === 'delete' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" />
                )}
                Delete ({selected.size})
              </Button>
            </>
          )}
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
      <div className={`rounded-md border ${isLoading && agents.length > 0 ? 'opacity-60' : ''}`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => toggleAll()}
                  aria-label="Select all on this page"
                  title="Select all on this page"
                />
              </TableHead>
              <TableHead>
                <Tip label="Sort this page by agent name">
                  <Button variant="ghost" className="-ml-4 h-8" onClick={() => handleSort('name')}>
                    Name
                    {renderSortIcon('name')}
                  </Button>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Profile this agent inherits persona / voice / guardrails from">
                  <span>Profile</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Number of tools (capabilities) attached to this agent">
                  <span>Tools</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Total chat conversations this agent has participated in">
                  <span>Chats</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Provider and model powering this agent's responses">
                  <span>Model</span>
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
              <TableHead>
                <Tip label="Most recent activity — bumped on any new conversation, inbound message, or LLM call. Drives the default sort.">
                  <Button
                    variant="ghost"
                    className="-ml-4 h-8"
                    onClick={() => handleSort('lastActiveAt')}
                  >
                    Last active
                    {renderSortIcon('lastActiveAt')}
                  </Button>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="When this agent was created">
                  <span>Created</span>
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
                <TableCell colSpan={12} className="py-10">
                  <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
                    <div className="bg-muted/50 rounded-full p-3">
                      <Plus className="text-muted-foreground h-6 w-6" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">No agents yet</p>
                      <p className="text-muted-foreground mt-1 text-sm">
                        Agents are configured AI personas with a system prompt, a model, and
                        capabilities they can call. Create your first one or run the setup wizard to
                        get a guided walkthrough.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                      <Button asChild size="sm">
                        <Link href="/admin/orchestration/agents/new">
                          <Plus className="mr-2 h-4 w-4" />
                          Create your first agent
                        </Link>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <Link href="/admin/orchestration">Open setup wizard</Link>
                      </Button>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : buckets ? (
              buckets.flatMap((bucket) => {
                const isCollapsed = collapsedBuckets[bucket.id] === true;
                const headerRow = (
                  <TableRow key={`bucket-${bucket.id}`} className="bg-muted/40 hover:bg-muted/50">
                    <TableCell colSpan={12} className="py-2">
                      <button
                        type="button"
                        onClick={() => toggleBucket(bucket.id)}
                        className="flex w-full items-center gap-2 text-left text-sm font-medium"
                        aria-expanded={!isCollapsed}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="text-muted-foreground h-4 w-4" />
                        ) : (
                          <ChevronDown className="text-muted-foreground h-4 w-4" />
                        )}
                        {bucket.isUnassigned ? (
                          <span className="text-muted-foreground">Unassigned</span>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            {bucket.isSystemProfile && (
                              <Shield
                                className="text-muted-foreground h-3 w-3"
                                aria-hidden="true"
                              />
                            )}
                            {bucket.label}
                          </span>
                        )}
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
                          {bucket.agents.length}
                        </Badge>
                      </button>
                    </TableCell>
                  </TableRow>
                );
                if (isCollapsed) return [headerRow];
                return [headerRow, ...bucket.agents.map((agent) => renderAgentRow(agent))];
              })
            ) : (
              agents.map((agent) => renderAgentRow(agent))
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

      {/* Bulk delete confirmation */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} agent{selected.size !== 1 ? 's' : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes the selected agents — they become inactive and are hidden from
              default lists, but their history is preserved. System agents are excluded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {listError && <p className="text-destructive text-sm">{listError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleBulkAction('delete')}
              className="bg-red-600 hover:bg-red-700"
              disabled={!!bulkAction}
            >
              {bulkAction === 'delete' ? 'Deleting…' : 'Delete'}
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
