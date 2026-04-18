import type { Metadata } from 'next';
import Link from 'next/link';

import { McpResourcesList } from '@/components/admin/orchestration/mcp/mcp-resources-list';
import { McpInfoModal } from '@/components/admin/orchestration/mcp/mcp-info-modal';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'MCP Resources · AI Orchestration',
  description: 'Manage data endpoints exposed to MCP clients.',
};

interface ResourceRow {
  id: string;
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  resourceType: string;
  isEnabled: boolean;
}

async function getResources(): Promise<ResourceRow[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.MCP_RESOURCES}?page=1&limit=50`);
    if (!res.ok) return [];
    const body = await parseApiResponse<ResourceRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('MCP resources page: fetch failed', err);
    return [];
  }
}

export default async function McpResourcesPage() {
  const resources = await getResources();

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
          <span>Resources</span>
        </nav>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          Resources
          <McpInfoModal title="MCP Resources">
            <p>
              Resources are read-only data endpoints that MCP clients can browse and read. They
              return data from your knowledge base, agent configs, and workflows.
            </p>
            <p className="text-foreground mt-2 font-medium">Resources vs Tools</p>
            <p>
              <strong className="text-foreground">Tools</strong> execute actions (send email, run
              query). <strong className="text-foreground">Resources</strong> just return data (list
              agents, search knowledge). Clients typically read resources first for context, then
              call tools to take action.
            </p>
            <p className="text-foreground mt-2 font-medium">How clients use them</p>
            <p>
              An MCP client like Claude Desktop calls{' '}
              <code className="text-xs">resources/list</code> to discover available resources, then{' '}
              <code className="text-xs">resources/read</code> with a URI to fetch data. The client
              needs a key with <code className="text-xs">resources:read</code> scope.
            </p>
          </McpInfoModal>
        </h1>
        <p className="text-muted-foreground text-sm">
          Read-only data endpoints that MCP clients can browse — your knowledge base, agents, and
          workflows exposed via the <code>sunrise://</code> URI scheme.
        </p>
      </header>

      <McpResourcesList initialResources={resources} />
    </div>
  );
}
