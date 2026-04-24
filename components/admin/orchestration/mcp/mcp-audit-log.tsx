'use client';

/**
 * MCP Audit Log Component
 *
 * Paginated audit log with method, status, and date range filters.
 */

import { useState, useCallback } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tip } from '@/components/ui/tooltip';
import { FieldHelp } from '@/components/ui/field-help';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  auditEntrySchema,
  auditMetaSchema,
  type AuditEntry,
  type AuditMeta,
} from '@/lib/validations/mcp';
import { z } from 'zod';

interface McpAuditLogProps {
  initialEntries: AuditEntry[];
  initialMeta: AuditMeta | null;
}

function getStatusVariant(code: string): 'default' | 'destructive' | 'secondary' {
  if (code === 'success') return 'default';
  if (code === 'error') return 'destructive';
  return 'secondary';
}

const MCP_METHODS = [
  'initialize',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'ping',
] as const;

const STATUS_OPTIONS = ['success', 'error', 'rate_limited'] as const;

export function McpAuditLog({ initialEntries, initialMeta }: McpAuditLogProps) {
  const [entries, setEntries] = useState(initialEntries);
  const [meta, setMeta] = useState<AuditMeta | null>(initialMeta);
  const [loading, setLoading] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  // Filters
  const [method, setMethod] = useState('');
  const [responseCode, setResponseCode] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const fetchEntries = useCallback(
    async (
      page: number,
      filters?: {
        method?: string;
        responseCode?: string;
        dateFrom?: string;
        dateTo?: string;
      }
    ) => {
      setLoading(true);
      try {
        const params: Record<string, string | number> = { page, limit: 50 };
        const f = filters ?? { method, responseCode, dateFrom, dateTo };
        if (f.method) params.method = f.method;
        if (f.responseCode) params.responseCode = f.responseCode;
        if (f.dateFrom) params.dateFrom = f.dateFrom;
        if (f.dateTo) params.dateTo = f.dateTo;

        const raw = await apiClient.get<unknown>(API.ADMIN.ORCHESTRATION.MCP_AUDIT, { params });
        // The API wraps in { data, meta } — apiClient extracts the top-level data field
        // which contains both data array and meta
        if (Array.isArray(raw)) {
          // Flat array response
          setEntries(z.array(auditEntrySchema).parse(raw));
          setMeta(null);
        } else if (raw && typeof raw === 'object' && 'data' in raw) {
          const envelope = z
            .object({ data: z.array(auditEntrySchema), meta: auditMetaSchema })
            .parse(raw);
          setEntries(envelope.data);
          setMeta(envelope.meta);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    },
    [method, responseCode, dateFrom, dateTo]
  );

  function handleApplyFilters() {
    void fetchEntries(1, { method, responseCode, dateFrom, dateTo });
  }

  function handleClearFilters() {
    setMethod('');
    setResponseCode('');
    setDateFrom('');
    setDateTo('');
    void fetchEntries(1, { method: '', responseCode: '', dateFrom: '', dateTo: '' });
  }

  async function handlePurge() {
    setPurging(true);
    setPurgeResult(null);
    try {
      const data = await apiClient.delete<{ deleted: number; message?: string }>(
        API.ADMIN.ORCHESTRATION.MCP_AUDIT
      );
      const deleted = typeof data.deleted === 'number' ? data.deleted : 0;
      setPurgeResult(
        deleted > 0
          ? `Purged ${String(deleted)} log entries`
          : (data.message ?? 'No old entries to purge')
      );
      // Refresh current page
      void fetchEntries(meta?.page ?? 1);
    } catch {
      setPurgeResult('Purge failed');
    } finally {
      setPurging(false);
    }
  }

  const hasFilters = method || responseCode || dateFrom || dateTo;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="filter-method">
                Method
                <FieldHelp title="MCP Method Filter">
                  Filter by the JSON-RPC method name (e.g. tools/call, resources/read).
                </FieldHelp>
              </Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="filter-method">
                  <SelectValue placeholder="All methods" />
                </SelectTrigger>
                <SelectContent>
                  {MCP_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="filter-status">
                Status
                <FieldHelp title="Response Status Filter">
                  Filter by operation outcome: success, error, or rate_limited.
                </FieldHelp>
              </Label>
              <Select value={responseCode} onValueChange={setResponseCode}>
                <SelectTrigger id="filter-status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="filter-date-from">From</Label>
              <Input
                id="filter-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="filter-date-to">To</Label>
              <Input
                id="filter-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" onClick={handleApplyFilters} disabled={loading}>
              {loading ? 'Loading...' : 'Apply Filters'}
            </Button>
            {hasFilters && (
              <Button size="sm" variant="outline" onClick={handleClearFilters} disabled={loading}>
                Clear Filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Purge + info */}
      <div className="flex items-center gap-3">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={purging}>
              {purging ? 'Purging...' : 'Purge Old Logs'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Purge old audit logs?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete audit log entries older than the configured retention
                period. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void handlePurge()}
              >
                Purge
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <FieldHelp title="Purge Old Logs">
          Deletes audit log entries older than the retention period configured in Settings. This
          action is irreversible.
        </FieldHelp>
        {purgeResult && <span className="text-muted-foreground text-xs">{purgeResult}</span>}
        {meta && (
          <span className="text-muted-foreground ml-auto text-xs">{meta.total} total entries</span>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Tip label="When the MCP operation was executed">
                  <span>Time</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="The MCP JSON-RPC method called (e.g. tools/call, resources/read)">
                  <span>Method</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="The specific tool slug or resource URI that was accessed">
                  <span>Target</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Whether the operation succeeded or returned an error">
                  <span>Status</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="How long the operation took to complete (in milliseconds)">
                  <span>Duration</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Which API key was used to authenticate this request">
                  <span>API Key</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Client IP address the request originated from">
                  <span>IP</span>
                </Tip>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                  {hasFilters
                    ? 'No entries match the current filters.'
                    : 'No audit entries yet. Operations will appear here once MCP clients connect.'}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(entry.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{entry.method}</code>
                  </TableCell>
                  <TableCell>
                    {entry.toolSlug ? (
                      <code className="text-xs">{entry.toolSlug}</code>
                    ) : entry.resourceUri ? (
                      <code className="text-xs">{entry.resourceUri}</code>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={getStatusVariant(entry.responseCode)}>
                      {entry.responseCode}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {entry.durationMs}ms
                  </TableCell>
                  <TableCell className="text-xs">
                    {entry.apiKey ? (
                      <span title={entry.apiKey.name}>{entry.apiKey.keyPrefix}...</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
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

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={meta.page <= 1 || loading}
            onClick={() => void fetchEntries(meta.page - 1)}
          >
            Previous
          </Button>
          <span className="text-muted-foreground text-sm">
            Page {meta.page} of {meta.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={meta.page >= meta.totalPages || loading}
            onClick={() => void fetchEntries(meta.page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
