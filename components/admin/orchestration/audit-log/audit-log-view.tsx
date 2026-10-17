'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { logger } from '@/lib/logging';
import { parsePaginationMeta } from '@/lib/validations/common';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
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
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';

interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  metadata: Record<string, unknown> | null;
  clientIp: string | null;
  createdAt: string;
  /** Null once the user is erased (`onDelete: SetNull`). */
  user: { id: string; name: string; email: string } | null;
  /**
   * Set when the action was made inside a support session (§121 t-825): the
   * org it was made in, and the grant — null once that org is erased.
   */
  supportOrgId: string | null;
  supportGrant: { id: string; level: string; org: { id: string; name: string } } | null;
}

type SupportFilter = 'all' | 'only' | 'none';

const SUPPORT_FILTERS: { value: SupportFilter; label: string }[] = [
  { value: 'all', label: 'All actions' },
  { value: 'only', label: 'Support sessions only' },
  { value: 'none', label: 'Not support sessions' },
];

/** Where a support row was made: the org's name, or its id once it is erased. */
function supportOrgLabel(entry: AuditEntry): string {
  return entry.supportGrant?.org.name ?? `erased org ${entry.supportOrgId ?? ''}`.trim();
}

const ENTITY_TYPES = [
  { value: 'all', label: 'All types' },
  { value: 'agent', label: 'Agents' },
  { value: 'workflow', label: 'Workflows' },
  { value: 'capability', label: 'Capabilities' },
  { value: 'provider', label: 'Providers' },
  { value: 'org', label: 'Organisations' },
  { value: 'mcp_api_key', label: 'MCP API keys' },
  { value: 'knowledge_document', label: 'Knowledge' },
  { value: 'settings', label: 'Settings' },
  { value: 'experiment', label: 'Experiments' },
  { value: 'embed_token', label: 'Embed tokens' },
  { value: 'backup', label: 'Backups' },
  { value: 'webhook', label: 'Event hooks' },
  { value: 'webhook_subscription', label: 'Webhook subscriptions' },
  { value: 'conversation', label: 'Conversations' },
  { value: 'dataset', label: 'Evaluation datasets' },
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
  const [support, setSupport] = useState<SupportFilter>('all');
  const [supportGrant, setSupportGrant] = useState<{ id: string; orgName: string } | null>(null);

  const limit = 25;
  const latestRequest = useRef(0);

  // Only a real change to the search resets the page. Scheduling on mount as
  // well sent anyone who paged within 300ms of load back to page 1 (t-799).
  useEffect(() => {
    const next = search.trim();
    if (next === debouncedSearch) return;
    const handle = setTimeout(() => {
      setDebouncedSearch(next);
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [search, debouncedSearch]);

  const fetchEntries = useCallback(async () => {
    // Only the latest request may write state: an older one that resolves
    // late would otherwise show rows for a page or filter no longer selected.
    const seq = ++latestRequest.current;
    const isCurrent = () => seq === latestRequest.current;
    // A failed load clears the rows, so the last page's entries are not shown
    // under a page or filter they don't belong to.
    const fail = (message: string) => {
      setError(message);
      setEntries([]);
    };
    setLoading(true);
    setError(null);
    setExpandedId(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (entityType !== 'all') params.set('entityType', entityType);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (support !== 'all') params.set('support', support);
      if (supportGrant) params.set('supportGrantId', supportGrant.id);
      const res = await fetch(`${API.ADMIN.ORCHESTRATION.AUDIT_LOG}?${params}`);
      if (!isCurrent()) return;
      if (!res.ok) {
        fail('Failed to load audit log. Please try again.');
        return;
      }
      const body = await parseApiResponse<AuditEntry[]>(res);
      if (!isCurrent()) return;
      const meta = body.success ? parsePaginationMeta(body.meta) : null;
      if (!body.success || !Array.isArray(body.data) || !meta) {
        fail('Server returned an error. Please try again.');
        return;
      }
      setEntries(body.data);
      setTotal(meta.total);
    } catch (err) {
      // A network failure, or a body that isn't a JSON API response
      if (!isCurrent()) return;
      logger.error('audit log fetch failed', err);
      fail('Failed to load audit log. Please try again.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [page, entityType, debouncedSearch, dateFrom, dateTo, support, supportGrant]);

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
        <Select
          value={support}
          onValueChange={(v) => {
            const next = SUPPORT_FILTERS.find((f) => f.value === v)?.value ?? 'all';
            setSupport(next);
            // A grant's actions are all support rows: 'none' and a grant match nothing.
            if (next === 'none') setSupportGrant(null);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[200px]" aria-label="Support sessions">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORT_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-end gap-2">
          <div>
            <Label htmlFor="audit-date-from" className="text-muted-foreground text-xs">
              From
            </Label>
            <DatePicker
              id="audit-date-from"
              value={dateFrom}
              onChange={(v) => {
                setDateFrom(v);
                setPage(1);
              }}
              className="w-[160px]"
            />
          </div>
          <div>
            <Label htmlFor="audit-date-to" className="text-muted-foreground text-xs">
              To
            </Label>
            <DatePicker
              id="audit-date-to"
              value={dateTo}
              onChange={(v) => {
                setDateTo(v);
                setPage(1);
              }}
              className="w-[160px]"
            />
          </div>
        </div>
      </div>

      {supportGrant && (
        <div className="flex items-center gap-2 text-sm">
          <span>
            Showing actions under one support grant for{' '}
            <span className="font-medium">{supportGrant.orgName}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Show every grant"
            onClick={() => {
              setSupportGrant(null);
              setPage(1);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

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
                    {expandedId === entry.id &&
                      (entry.changes || entry.metadata || entry.supportOrgId) && (
                        <div className="bg-muted mt-2 space-y-2 rounded p-2 text-xs">
                          {entry.supportOrgId && (
                            <div className="flex flex-wrap items-center gap-2">
                              <span>
                                Made during a support session in {supportOrgLabel(entry)}
                                {entry.supportGrant
                                  ? `, under a ${entry.supportGrant.level === 'READ_ONLY' ? 'read-only' : 'admin'} grant`
                                  : ''}
                                .
                              </span>
                              {entry.supportGrant && entry.supportGrant.id !== supportGrant?.id && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 text-xs"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const grant = entry.supportGrant;
                                    if (!grant) return;
                                    setSupportGrant({ id: grant.id, orgName: grant.org.name });
                                    setPage(1);
                                  }}
                                >
                                  Show this grant&apos;s actions
                                </Button>
                              )}
                            </div>
                          )}
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
                  <TableCell className="text-sm">
                    {entry.user?.name ?? 'Erased user'}
                    {entry.supportOrgId && (
                      <Badge
                        variant="outline"
                        className="ml-2"
                        title={`Support session in ${supportOrgLabel(entry)}`}
                      >
                        Support
                      </Badge>
                    )}
                  </TableCell>
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
