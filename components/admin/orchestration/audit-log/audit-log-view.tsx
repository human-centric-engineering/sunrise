'use client';

import { useCallback, useEffect, useState } from 'react';
import { API } from '@/lib/api/endpoints';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  metadata: Record<string, unknown> | null;
  clientIp: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
}

const ENTITY_TYPES = [
  { value: 'all', label: 'All types' },
  { value: 'agent', label: 'Agents' },
  { value: 'workflow', label: 'Workflows' },
  { value: 'capability', label: 'Capabilities' },
  { value: 'provider', label: 'Providers' },
  { value: 'mcp_api_key', label: 'MCP API keys' },
  { value: 'knowledge_document', label: 'Knowledge' },
  { value: 'settings', label: 'Settings' },
  { value: 'experiment', label: 'Experiments' },
  { value: 'embed_token', label: 'Embed tokens' },
  { value: 'backup', label: 'Backups' },
  { value: 'webhook', label: 'Event hooks' },
  { value: 'webhook_subscription', label: 'Webhook subscriptions' },
  { value: 'conversation', label: 'Conversations' },
];

function actionBadgeVariant(action: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (action.endsWith('.create')) return 'default';
  if (action.endsWith('.update')) return 'secondary';
  if (action.endsWith('.delete') || action.endsWith('_clear')) return 'destructive';
  return 'outline';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AuditLogView() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [entityType, setEntityType] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const limit = 25;

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExpandedId(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (entityType !== 'all') params.set('entityType', entityType);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      const res = await fetch(`${API.ADMIN.ORCHESTRATION.AUDIT_LOG}?${params}`);
      if (!res.ok) {
        setError('Failed to load audit log. Please try again.');
        return;
      }
      const json = (await res.json()) as {
        success: boolean;
        data: AuditEntry[];
        meta: { total: number };
      };
      if (json.success) {
        setEntries(json.data);
        setTotal(json.meta.total);
      } else {
        setError('Server returned an error. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [page, entityType, debouncedSearch, dateFrom, dateTo]);

  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-muted-foreground text-sm">
            Track admin configuration changes across all orchestration resources.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchEntries()} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Input
          placeholder="Filter by action, name, or user..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={entityType}
          onValueChange={(v) => {
            setEntityType(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENTITY_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-end gap-2">
          <div>
            <Label htmlFor="audit-date-from" className="text-muted-foreground text-xs">
              From
            </Label>
            <Input
              id="audit-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="w-[140px]"
            />
          </div>
          <div>
            <Label htmlFor="audit-date-to" className="text-muted-foreground text-xs">
              To
            </Label>
            <Input
              id="audit-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="w-[140px]"
            />
          </div>
        </div>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Timestamp</TableHead>
              <TableHead className="w-[140px]">Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead className="w-[140px]">User</TableHead>
              <TableHead className="w-[110px]">IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                  {loading ? 'Loading...' : 'No audit entries found.'}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow
                  key={entry.id}
                  className="cursor-pointer"
                  onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                >
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDate(entry.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={actionBadgeVariant(entry.action)}>{entry.action}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{entry.entityName ?? entry.entityId ?? '—'}</span>
                    <span className="text-muted-foreground ml-2 text-xs">{entry.entityType}</span>
                    {expandedId === entry.id && (entry.changes || entry.metadata) && (
                      <div className="bg-muted mt-2 space-y-2 rounded p-2 text-xs">
                        {entry.changes && (
                          <div>
                            <span className="text-muted-foreground font-medium">Changes</span>
                            <pre className="overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(entry.changes, null, 2)}
                            </pre>
                          </div>
                        )}
                        {entry.metadata && (
                          <div>
                            <span className="text-muted-foreground font-medium">Metadata</span>
                            <pre className="overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(entry.metadata, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{entry.user.name}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {entry.clientIp ?? '—'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {total} {total === 1 ? 'entry' : 'entries'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label="Next page"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
