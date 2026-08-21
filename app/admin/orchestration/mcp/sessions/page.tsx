import type { Metadata } from 'next';
import Link from 'next/link';

import { McpSessionsList } from '@/components/admin/orchestration/mcp/mcp-sessions-list';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { env } from '@/lib/env';
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
      <nav className="text-muted-foreground -mb-5 text-xs">
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

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="text-2xl font-semibold">Active Sessions</h1>
        <p className="text-muted-foreground text-sm">
          In-memory MCP sessions from connected clients. Sessions expire after inactivity.
        </p>
      </header>

      {/*
        Without this the page is actively misleading under the default session
        mode: it renders an empty table while MCP traffic is flowing, which reads
        as "nobody is connected" rather than "this deployment does not track
        sessions". A server component, so it can read the server-only env
        directly rather than plumbing the mode through the API.
      */}
      {env.MCP_SESSION_MODE === 'stateless' && (
        <div className="border-muted-foreground/30 bg-muted/40 text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          <p className="text-foreground font-medium">This deployment does not track sessions.</p>
          <p className="mt-1">
            <code>MCP_SESSION_MODE=stateless</code> (the default) holds no session state, so this
            list is always empty even while clients are connected — and{' '}
            <strong>Max sessions per key has no effect</strong>. That is what makes MCP work where
            more than one process serves traffic. Set <code>MCP_SESSION_MODE=stateful</code> on a
            single long-running process to track sessions here.
          </p>
        </div>
      )}

      <McpSessionsList initialSessions={sessions} />
    </div>
  );
}
