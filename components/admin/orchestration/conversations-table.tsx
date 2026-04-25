'use client';

/**
 * ConversationsTable
 *
 * Admin list view for AI conversations. Supports:
 *   - Title search (300ms debounce via ?q=)
 *   - Message content search — semantic via `/conversations/search`
 *     (pgvector) with automatic fallback to lexical `?messageSearch=`
 *     when no embedding provider is configured.
 *   - Agent filter dropdown
 *   - Active/inactive filter
 *   - Pagination (prev/next) — disabled while a semantic search is active.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import type { PaginationMeta } from '@/types/api';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConversationListItem {
  id: string;
  title: string | null;
  isActive: boolean;
  agentId: string | null;
  agent?: { id: string; name: string; slug: string } | null;
  _count?: { messages: number };
  createdAt: string;
  updatedAt: string;
}

export interface AgentOption {
  id: string;
  name: string;
}

export interface ConversationsTableProps {
  initialConversations: ConversationListItem[];
  initialMeta: PaginationMeta;
  agents: AgentOption[];
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ConversationsTable({
  initialConversations,
  initialMeta,
  agents,
}: ConversationsTableProps) {
  const [conversations, setConversations] = useState(initialConversations);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState('');
  const [searchMessages, setSearchMessages] = useState(false);
  const [agentFilter, setAgentFilter] = useState('all');
  const [activeFilter, setActiveFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const fetchConversations = useCallback(
    async (
      page = 1,
      overrides?: { search?: string; agentId?: string; isActive?: string; searchMessages?: boolean }
    ) => {
      setIsLoading(true);
      setListError(null);
      try {
        const searchValue = overrides?.search !== undefined ? overrides.search : search;
        const agentValue = overrides?.agentId !== undefined ? overrides.agentId : agentFilter;
        const activeValue = overrides?.isActive !== undefined ? overrides.isActive : activeFilter;
        const msgSearch =
          overrides?.searchMessages !== undefined ? overrides.searchMessages : searchMessages;

        // Semantic search path: when "Search messages" is on and there is
        // a non-empty query, hit the pgvector-backed search endpoint first.
        // If the server signals `semanticAvailable: false`, fall through to
        // the lexical list endpoint below.
        if (msgSearch && searchValue) {
          const semanticParams = new URLSearchParams({ q: searchValue });
          if (agentValue && agentValue !== 'all') semanticParams.set('agentId', agentValue);

          const semanticRes = await fetch(
            `${API.ADMIN.ORCHESTRATION.CONVERSATIONS_SEARCH}?${semanticParams.toString()}`,
            { credentials: 'same-origin' }
          );

          if (semanticRes.ok) {
            const semanticBody = await parseApiResponse<ConversationListItem[]>(semanticRes);
            const semanticMeta = semanticBody.success
              ? (semanticBody.meta as { semanticAvailable?: boolean } | undefined)
              : undefined;
            if (semanticBody.success && semanticMeta?.semanticAvailable !== false) {
              setConversations(semanticBody.data);
              // Semantic results come back un-paginated; pin meta to a
              // single page so the pager doesn't render.
              setMeta({
                page: 1,
                limit: meta.limit,
                total: semanticBody.data.length,
                totalPages: 1,
              });
              return;
            }
            // Otherwise: semanticAvailable === false → fall through to
            // lexical `?messageSearch=` below.
          }
        }

        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
        });

        if (searchValue) {
          if (msgSearch) {
            params.set('messageSearch', searchValue);
          } else {
            params.set('q', searchValue);
          }
        }
        if (agentValue && agentValue !== 'all') params.set('agentId', agentValue);
        if (activeValue && activeValue !== 'all') params.set('isActive', activeValue);

        const res = await fetch(`${API.ADMIN.ORCHESTRATION.CONVERSATIONS}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('list failed');

        const body = await parseApiResponse<ConversationListItem[]>(res);
        if (!body.success) throw new Error('list failed');

        setConversations(body.data);
        const parsedMeta = parsePaginationMeta(body.meta);
        if (parsedMeta) setMeta(parsedMeta);
      } catch {
        setListError('Could not load conversations. Try refreshing the page.');
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit, search, agentFilter, activeFilter, searchMessages]
  );

  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        void fetchConversations(1, { search: value });
      }, 300);
    },
    [fetchConversations]
  );

  const handleToggleMessageSearch = useCallback(
    (checked: boolean) => {
      setSearchMessages(checked);
      if (search) {
        void fetchConversations(1, { searchMessages: checked });
      }
    },
    [fetchConversations, search]
  );

  const handleAgentFilter = useCallback(
    (value: string) => {
      setAgentFilter(value);
      void fetchConversations(1, { agentId: value });
    },
    [fetchConversations]
  );

  const handleActiveFilter = useCallback(
    (value: string) => {
      setActiveFilter(value);
      void fetchConversations(1, { isActive: value });
    },
    [fetchConversations]
  );

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative max-w-xs flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 h-4 w-4" />
            <Input
              placeholder={searchMessages ? 'Search message content…' : 'Search by title…'}
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Checkbox
              id="msg-search"
              checked={searchMessages}
              onCheckedChange={(v) => handleToggleMessageSearch(!!v)}
            />
            <Label htmlFor="msg-search" className="text-xs font-normal">
              Search messages
            </Label>
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
          <Select value={activeFilter} onValueChange={handleActiveFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Active</SelectItem>
              <SelectItem value="false">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const params = new URLSearchParams({ format: 'json' });
              if (agentFilter && agentFilter !== 'all') params.set('agentId', agentFilter);
              if (activeFilter && activeFilter !== 'all') params.set('isActive', activeFilter);
              if (search) {
                if (searchMessages) {
                  params.set('messageSearch', search);
                } else {
                  params.set('q', search);
                }
              }
              window.location.href = `${API.ADMIN.ORCHESTRATION.CONVERSATIONS_EXPORT}?${params}`;
            }}
            title="Export conversations as JSON"
          >
            <Download className="mr-1 h-4 w-4" /> Export
          </Button>
        </div>
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
              <TableHead>
                <Tip label="Conversation title — click to view messages">
                  <span>Title</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="The agent used in this conversation">
                  <span>Agent</span>
                </Tip>
              </TableHead>
              <TableHead className="text-center">
                <Tip label="Total messages exchanged">
                  <span>Messages</span>
                </Tip>
              </TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {conversations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-8 text-center text-sm">
                  {isLoading ? 'Loading…' : 'No conversations found.'}
                </TableCell>
              </TableRow>
            ) : (
              conversations.map((conv) => (
                <TableRow key={conv.id} className={isLoading ? 'opacity-50' : undefined}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/orchestration/conversations/${conv.id}`}
                      className="hover:underline"
                    >
                      {conv.title || 'Untitled'}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {conv.agent?.name ?? '—'}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {conv._count?.messages ?? 0}
                  </TableCell>
                  <TableCell>
                    <Badge variant={conv.isActive ? 'default' : 'outline'}>
                      {conv.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(conv.updatedAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            Page {meta.page} of {meta.totalPages} ({meta.total} total)
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page <= 1 || isLoading}
              onClick={() => void fetchConversations(meta.page - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page >= meta.totalPages || isLoading}
              onClick={() => void fetchConversations(meta.page + 1)}
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
