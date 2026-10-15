import type { Metadata } from 'next';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import Link from 'next/link';

import { McpInfoModal } from '@/components/admin/orchestration/mcp/mcp-info-modal';
import { McpDashboard } from '@/components/admin/orchestration/mcp/mcp-dashboard';
import { API } from '@/lib/api/endpoints';
import { adminPageViewerTier } from '@/lib/auth/admin-page-viewer';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { mcpSettingsResponseSchema, type McpSettingsResponse } from '@/lib/validations/mcp';

export const metadata: Metadata = {
  title: 'MCP Server · AI Orchestration',
  description: 'Configure Model Context Protocol server for external AI client access.',
};

async function getMcpSettings(): Promise<McpSettingsResponse | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MCP_SETTINGS);
    if (!res.ok) return null;
    const body = await parseApiResponse<unknown>(res);
    if (!body.success) return null;
    return mcpSettingsResponseSchema.parse(body.data);
  } catch (err) {
    logger.error('MCP dashboard: settings fetch failed', err);
    return null;
  }
}

/**
 * The count on each card. An org viewer (§111 t-812) gets the keys count only:
 * the other three lists are the platform's, and their routes refuse them.
 */
async function getStats(platformRead: Promise<boolean>): Promise<{
  tools: number;
  resources: number;
  prompts: number;
  keys: number;
}> {
  // One list's total, or 0 when it is not fetched or fails.
  const total = async (path: string | null): Promise<number> => {
    if (!path) return 0;
    const res = await serverFetch(`${path}?page=1&limit=1`);
    if (!res.ok) return 0;
    const body = await parseApiResponse<unknown[]>(res);
    if (!body.success || !body.meta || typeof body.meta !== 'object' || !('total' in body.meta))
      return 0;
    const value = (body.meta as Record<string, unknown>).total;
    return typeof value === 'number' ? value : 0;
  };
  // A platform-only list's total; the keys count does not wait on the tier.
  const platformTotal = async (path: string): Promise<number> =>
    total((await platformRead) ? path : null);

  try {
    const [tools, resources, prompts, keys] = await Promise.all([
      platformTotal(API.ADMIN.ORCHESTRATION.MCP_TOOLS),
      platformTotal(API.ADMIN.ORCHESTRATION.MCP_RESOURCES),
      platformTotal(API.ADMIN.ORCHESTRATION.MCP_PROMPTS),
      total(API.ADMIN.ORCHESTRATION.MCP_KEYS),
    ]);

    return { tools, resources, prompts, keys };
  } catch {
    return { tools: 0, resources: 0, prompts: 0, keys: 0 };
  }
}

export default async function McpDashboardPage() {
  const viewerTierRead = adminPageViewerTier();
  const platformRead = viewerTierRead.then((tier) => tier === 'platform');
  // The server's settings are the platform's (§111 t-812): an org viewer's
  // dashboard shows none of them, and the route refuses them.
  const [viewerTier, settings, stats] = await Promise.all([
    viewerTierRead,
    platformRead.then((isPlatform) => (isPlatform ? getMcpSettings() : null)),
    getStats(platformRead),
  ]);
  const platform = viewerTier === 'platform';

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <span>MCP Server</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
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
          app&apos;s capabilities.{' '}
          {platform
            ? 'You control exactly what is exposed — nothing is shared until you enable it.'
            : 'The platform admin decides what the server exposes. Here you manage the API keys your organisation uses to connect.'}
        </p>
      </header>

      {platform && <SharedSettingsReadOnlyNotice />}

      <McpDashboard initialSettings={settings} stats={stats} viewerTier={viewerTier} />
    </div>
  );
}
