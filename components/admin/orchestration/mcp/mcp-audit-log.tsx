'use client';

/**
 * MCP Audit Log Component
 *
 * Read-only paginated audit log with method/status filters.
 */

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';

interface AuditEntry {
  id: string;
  method: string;
  toolSlug: string | null;
  resourceUri: string | null;
  responseCode: string;
  errorMessage: string | null;
  durationMs: number;
  clientIp: string | null;
  createdAt: string;
  apiKey: { name: string; keyPrefix: string } | null;
}

interface McpAuditLogProps {
  initialEntries: AuditEntry[];
}

function getStatusVariant(code: string): 'default' | 'destructive' | 'secondary' {
  if (code === 'success') return 'default';
  if (code === 'error') return 'destructive';
  return 'secondary';
}

export function McpAuditLog({ initialEntries }: McpAuditLogProps) {
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  async function handlePurge() {
    setPurging(true);
    setPurgeResult(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.MCP_AUDIT, { method: 'DELETE' });
      const raw: unknown = await res.json();
      const body = raw as Record<string, unknown>;
      if (body?.success === true && typeof body.data === 'object' && body.data !== null) {
        const data = body.data as Record<string, unknown>;
        const deleted = typeof data.deleted === 'number' ? data.deleted : 0;
        setPurgeResult(
          deleted > 0
            ? `Purged ${String(deleted)} log entries`
            : typeof data.message === 'string'
              ? data.message
              : 'No old entries to purge'
        );
      }
    } catch {
      setPurgeResult('Purge failed');
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => void handlePurge()} disabled={purging}>
          {purging ? 'Purging...' : 'Purge Old Logs'}
        </Button>
        <FieldHelp title="Purge Old Logs">
          Deletes audit log entries older than the retention period configured in Settings. This
          action is irreversible.
        </FieldHelp>
        {purgeResult && <span className="text-muted-foreground text-xs">{purgeResult}</span>}
      </div>
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
            {initialEntries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                  No audit entries yet. Operations will appear here once MCP clients connect.
                </TableCell>
              </TableRow>
            ) : (
              initialEntries.map((entry) => (
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
    </div>
  );
}
