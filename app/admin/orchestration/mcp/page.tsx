import type { Metadata } from 'next';
import Link from 'next/link';

import { McpInfoModal } from '@/components/admin/orchestration/mcp/mcp-info-modal';
import { McpDashboard } from '@/components/admin/orchestration/mcp/mcp-dashboard';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'MCP Server · AI Orchestration',
  description: 'Configure Model Context Protocol server for external AI client access.',
};

interface McpSettingsData {
  isEnabled: boolean;
  serverName: string;
  serverVersion: string;
  maxSessionsPerKey: number;
  globalRateLimit: number;
  auditRetentionDays: number;
}

async function getMcpSettings(): Promise<McpSettingsData | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MCP_SETTINGS);
    if (!res.ok) return null;
    const body = await parseApiResponse<McpSettingsData>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('MCP dashboard: settings fetch failed', err);
    return null;
  }
}

async function getStats(): Promise<{ tools: number; resources: number; keys: number }> {
  try {
    const [toolsRes, resourcesRes, keysRes] = await Promise.all([
      serverFetch(`${API.ADMIN.ORCHESTRATION.MCP_TOOLS}?page=1&limit=1`),
      serverFetch(`${API.ADMIN.ORCHESTRATION.MCP_RESOURCES}?page=1&limit=1`),
      serverFetch(`${API.ADMIN.ORCHESTRATION.MCP_KEYS}?page=1&limit=1`),
    ]);

    const parseMeta = async (res: Response): Promise<number> => {
      if (!res.ok) return 0;
      const body = await parseApiResponse<unknown[]>(res);
      if (!body.success || !body.meta || typeof body.meta !== 'object' || !('total' in body.meta))
        return 0;
      const total = (body.meta as Record<string, unknown>).total;
      return typeof total === 'number' ? total : 0;
    };

    const [tools, resources, keys] = await Promise.all([
      parseMeta(toolsRes),
      parseMeta(resourcesRes),
      parseMeta(keysRes),
    ]);

    return { tools, resources, keys };
  } catch {
    return { tools: 0, resources: 0, keys: 0 };
  }
}

export default async function McpDashboardPage() {
  const [settings, stats] = await Promise.all([getMcpSettings(), getStats()]);

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>MCP Server</span>
        </nav>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          MCP Server
          <McpInfoModal title="What is MCP?">
            <p>
              <strong className="text-foreground">Model Context Protocol (MCP)</strong> lets
              external AI assistants — Claude Desktop, Cursor, custom agents — connect to your
              application and use its tools, data, and prompts.
            </p>
            <p>
              Think of it as a USB-C port for AI: one standard connector, many devices. Any
              MCP-compatible client can discover and call your capabilities without custom
              integration code.
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              Clients connect via HTTP to your MCP endpoint, authenticate with an API key, and use
              JSON-RPC to list and call tools, read resources, and get prompt templates. Everything
              is disabled by default — you control exactly what is exposed.
            </p>
            <p className="text-foreground mt-2 font-medium">Security</p>
            <p>
              API keys with configurable scopes, per-key rate limits, and a full audit trail of
              every operation. Keys are hashed at rest — the plaintext is shown once at creation.
            </p>
          </McpInfoModal>
        </h1>
        <p className="text-muted-foreground text-sm">
          MCP lets external AI clients (Claude Desktop, Cursor, custom agents) discover and use your
          app&apos;s capabilities. You control exactly what is exposed — nothing is shared until you
          enable it.
        </p>
      </header>

      <McpDashboard initialSettings={settings} stats={stats} />
    </div>
  );
}
