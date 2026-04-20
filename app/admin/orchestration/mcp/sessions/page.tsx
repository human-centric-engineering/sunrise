import type { Metadata } from 'next';
import Link from 'next/link';

import { McpSessionsList } from '@/components/admin/orchestration/mcp/mcp-sessions-list';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'MCP Sessions · AI Orchestration',
  description: 'View active MCP client sessions.',
};

interface SessionRow {
  id: string;
  apiKeyId: string;
  initialized: boolean;
  createdAt: number;
  lastActivityAt: number;
}

async function getSessions(): Promise<SessionRow[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MCP_SESSIONS);
    if (!res.ok) return [];
    const body = await parseApiResponse<SessionRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('MCP sessions page: fetch failed', err);
    return [];
  }
}

export default async function McpSessionsPage() {
  const sessions = await getSessions();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <Link href="/admin/orchestration/mcp" className="hover:underline">
            MCP Server
          </Link>
          {' / '}
          <span>Sessions</span>
        </nav>
        <h1 className="text-2xl font-semibold">Active Sessions</h1>
        <p className="text-muted-foreground text-sm">
          In-memory MCP sessions from connected clients. Sessions expire after inactivity.
        </p>
      </header>

      <McpSessionsList initialSessions={sessions} />
    </div>
  );
}
