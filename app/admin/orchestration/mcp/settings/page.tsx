import type { Metadata } from 'next';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import Link from 'next/link';

import { McpSettingsForm } from '@/components/admin/orchestration/mcp/mcp-settings-form';
import { API } from '@/lib/api/endpoints';
import { requireServerData, ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { mcpSettingsResponseSchema, type McpSettingsResponse } from '@/lib/validations/mcp';

export const metadata: Metadata = {
  title: 'MCP Settings · AI Orchestration',
  description: 'Configure MCP server rate limits and audit retention.',
};

/**
 * Required: the form falls back to defaults when it has no settings, and
 * saving those would overwrite the real ones. A failed load throws to the
 * admin error boundary instead (#518).
 */
async function getSettings(): Promise<McpSettingsResponse> {
  const path = API.ADMIN.ORCHESTRATION.MCP_SETTINGS;
  const { data } = await requireServerData<unknown>(path);
  const parsed = mcpSettingsResponseSchema.safeParse(data);
  if (!parsed.success) {
    logger.error('MCP settings page: settings response did not parse', parsed.error, { path });
    throw new ServerLoadError(path, { kind: 'failed', status: 200, code: null });
  }
  return parsed.data;
}

export default async function McpSettingsPage() {
  const settings = await getSettings();

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
        <span>Settings</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="text-2xl font-semibold">MCP Settings</h1>
        <p className="text-muted-foreground text-sm">
          Configure rate limits and audit log retention.
        </p>
      </header>

      <SharedSettingsReadOnlyNotice />

      <McpSettingsForm initialSettings={settings} />
    </div>
  );
}
