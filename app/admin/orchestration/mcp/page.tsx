import type { Metadata } from 'next';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import Link from 'next/link';

import { McpInfoModal } from '@/components/admin/orchestration/mcp/mcp-info-modal';
import { McpDashboard } from '@/components/admin/orchestration/mcp/mcp-dashboard';
import { API } from '@/lib/api/endpoints';
import { adminPageViewerTier } from '@/lib/auth/admin-page-viewer';
import { loadServerData, requireServerData, ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { mcpSettingsResponseSchema, type McpSettingsResponse } from '@/lib/validations/mcp';

export const metadata: Metadata = {
  title: 'MCP Server · AI Orchestration',
  description: 'Configure Model Context Protocol server for external AI client access.',
};

/**
 * Required, not a degradable panel: the dashboard would otherwise show the
 * server as "Disabled" — a false signal — whenever the load failed. A failed
 * load throws to the admin error boundary (#518).
 */
async function getMcpSettings(): Promise<McpSettingsResponse> {
  const path = API.ADMIN.ORCHESTRATION.MCP_SETTINGS;
  const { data } = await requireServerData<unknown>(path);
  const parsed = mcpSettingsResponseSchema.safeParse(data);
  if (!parsed.success) {
    logger.error('MCP dashboard: settings response did not parse', parsed.error, { path });
    throw new ServerLoadError(path, { kind: 'failed', status: 200, code: null });
  }
  return parsed.data;
}

function hasNumericTotal(meta: unknown): meta is { total: number } {
  return (
    typeof meta === 'object' && meta !== null && 'total' in meta && typeof meta.total === 'number'
  );
}

/**
 * The count on each card. An org viewer (§111 t-812) gets the keys count only:
 * the other three lists are the platform's, and their routes refuse them.
 *
 * A failed count is `null`, never 0 (#518): its card shows "—" with a notice,
 * and a `null` never triggers the "Getting Started" card that zero tools and
 * keys would. The failure is logged by `loadServerData`; the page still renders.
 */
async function getStats(platformRead: Promise<boolean>): Promise<{
  tools: number | null;
  resources: number | null;
  prompts: number | null;
  keys: number | null;
}> {
  // One list's total, 0 when it is not fetched for this viewer, or null when
  // the load failed.
  const total = async (path: string | null): Promise<number | null> => {
    if (!path) return 0;
    const result = await loadServerData<unknown[]>(`${path}?page=1&limit=1`);
    if (!result.ok) return null;
    return hasNumericTotal(result.meta) ? result.meta.total : 0;
  };
  // A platform-only list's total; the keys count does not wait on the tier.
  const platformTotal = async (path: string): Promise<number | null> =>
    total((await platformRead) ? path : null);

  const [tools, resources, prompts, keys] = await Promise.all([
    platformTotal(API.ADMIN.ORCHESTRATION.MCP_TOOLS),
    platformTotal(API.ADMIN.ORCHESTRATION.MCP_RESOURCES),
    platformTotal(API.ADMIN.ORCHESTRATION.MCP_PROMPTS),
    total(API.ADMIN.ORCHESTRATION.MCP_KEYS),
  ]);

  return { tools, resources, prompts, keys };
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
              external AI assistants — Claude Code, Cursor, custom agents — connect to your
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
          MCP lets external AI clients (Claude Code, Cursor, custom agents) discover and use your
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
