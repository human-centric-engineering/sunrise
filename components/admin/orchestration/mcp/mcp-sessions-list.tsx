'use client';

/**
 * MCP Sessions List Component
 *
 * Displays active MCP sessions with refresh capability.
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
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

interface SessionRow {
  id: string;
  apiKeyId: string;
  initialized: boolean;
  createdAt: number;
  lastActivityAt: number;
}

interface McpSessionsListProps {
  initialSessions: SessionRow[];
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function McpSessionsList({ initialSessions }: McpSessionsListProps) {
  const [sessions, setSessions] = useState(initialSessions);
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const data = await apiClient.get<SessionRow[]>(API.ADMIN.ORCHESTRATION.MCP_SESSIONS);
      setSessions(data);
    } catch {
      // silent
    } finally {
      setRefreshing(false);
    }
  }

  const now = Date.now();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
        <span className="text-muted-foreground text-xs">
          {sessions.length} active session{sessions.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Tip label="Unique session identifier">
                  <span>Session ID</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="The API key used to create this session">
                  <span>API Key ID</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Whether the MCP initialize handshake has completed">
                  <span>Status</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="When this session was created">
                  <span>Connected</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="How long ago the last request was made on this session">
                  <span>Last Activity</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Total time this session has been active">
                  <span>Duration</span>
                </Tip>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                  No active sessions. Sessions appear when MCP clients connect and send requests.
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <code className="text-xs">{session.id.slice(0, 8)}...</code>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{session.apiKeyId.slice(0, 8)}...</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={session.initialized ? 'default' : 'secondary'}>
                      {session.initialized ? 'Initialized' : 'Pending'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(session.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDuration(now - session.lastActivityAt)} ago
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDuration(now - session.createdAt)}
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
