import type { Metadata } from 'next';
import Link from 'next/link';

import { McpToolsList } from '@/components/admin/orchestration/mcp/mcp-tools-list';
import { McpInfoModal } from '@/components/admin/orchestration/mcp/mcp-info-modal';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'MCP Tools · AI Orchestration',
  description: 'Manage which capabilities are exposed to MCP clients.',
};

interface ExposedToolRow {
  id: string;
  capabilityId: string;
  isEnabled: boolean;
  customName: string | null;
  customDescription: string | null;
  rateLimitPerKey: number | null;
  requiresScope: string | null;
  capability: {
    id: string;
    name: string;
    slug: string;
    description: string;
    category: string;
  };
}

interface CapabilityRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
}

async function getExposedTools(): Promise<ExposedToolRow[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.MCP_TOOLS}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<ExposedToolRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('MCP tools page: fetch failed', err);
    return [];
  }
}

async function getCapabilities(): Promise<CapabilityRow[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<CapabilityRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('MCP tools page: capabilities fetch failed', err);
    return [];
  }
}

export default async function McpToolsPage() {
  const [tools, capabilities] = await Promise.all([getExposedTools(), getCapabilities()]);

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
          <span>Tools</span>
        </nav>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          Exposed Tools
          <McpInfoModal title="MCP Tools">
            <p>
              MCP tools are your existing capabilities exposed to external AI clients. Each tool
              maps to a capability in your orchestration system.
            </p>
            <p className="text-foreground mt-2 font-medium">Default-deny</p>
            <p>
              Nothing is exposed until you explicitly enable it. Each capability must be added here
              and toggled on before MCP clients can see or call it.
            </p>
            <p className="text-foreground mt-2 font-medium">What clients see</p>
            <p>
              MCP clients see the tool name, description, and parameter schema. They can then call
              the tool, which executes through the same capability pipeline as internal agent calls
              — with rate limiting, validation, and audit logging.
            </p>
          </McpInfoModal>
        </h1>
        <p className="text-muted-foreground text-sm">
          Pick which of your orchestration capabilities external AI clients can discover and call.
          Each tool added here maps to an existing capability — with the same validation, rate
          limiting, and audit logging.
        </p>
      </header>

      <McpToolsList initialTools={tools} capabilities={capabilities} />
    </div>
  );
}
