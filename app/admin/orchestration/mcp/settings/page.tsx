import type { Metadata } from 'next';
import Link from 'next/link';

import { McpSettingsForm } from '@/components/admin/orchestration/mcp/mcp-settings-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'MCP Settings · AI Orchestration',
  description: 'Configure MCP server rate limits, sessions, and retention.',
};

interface McpSettings {
  isEnabled: boolean;
  serverName: string;
  serverVersion: string;
  maxSessionsPerKey: number;
  globalRateLimit: number;
  auditRetentionDays: number;
}

async function getSettings(): Promise<McpSettings | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MCP_SETTINGS);
    if (!res.ok) return null;
    const body = await parseApiResponse<McpSettings>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('MCP settings page: fetch failed', err);
    return null;
  }
}

export default async function McpSettingsPage() {
  const settings = await getSettings();

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
          <span>Settings</span>
        </nav>
        <h1 className="text-2xl font-semibold">MCP Settings</h1>
        <p className="text-muted-foreground text-sm">
          Configure rate limits, session limits, and audit log retention.
        </p>
      </header>

      <McpSettingsForm initialSettings={settings} />
    </div>
  );
}
