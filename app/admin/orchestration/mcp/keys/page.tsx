import type { Metadata } from 'next';
import Link from 'next/link';

import { McpKeysList } from '@/components/admin/orchestration/mcp/mcp-keys-list';
import { McpInfoModal } from '@/components/admin/orchestration/mcp/mcp-info-modal';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'MCP API Keys · AI Orchestration',
  description: 'Manage API keys for MCP client authentication.',
};

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  rateLimitOverride: number | null;
  createdAt: string;
  creator: { name: string; email: string };
}

async function getKeys(): Promise<ApiKeyRow[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.MCP_KEYS}?page=1&limit=50`);
    if (!res.ok) return [];
    const body = await parseApiResponse<ApiKeyRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('MCP keys page: fetch failed', err);
    return [];
  }
}

export default async function McpKeysPage() {
  const keys = await getKeys();

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
          <span>API Keys</span>
        </nav>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          API Keys
          <McpInfoModal title="MCP API Keys">
            <p>
              API keys authenticate external MCP clients connecting to your server. Each key has
              configurable scopes that control what the client can do.
            </p>
            <p className="text-foreground mt-2 font-medium">Scopes</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                <code className="text-xs">tools:list</code> — list available tools
              </li>
              <li>
                <code className="text-xs">tools:execute</code> — call tools
              </li>
              <li>
                <code className="text-xs">resources:read</code> — read data resources
              </li>
              <li>
                <code className="text-xs">prompts:read</code> — access prompt templates
              </li>
            </ul>
            <p className="text-foreground mt-2 font-medium">Security</p>
            <p>
              Keys are shown once at creation — store them securely. Revoke immediately if
              compromised. The key hash is stored, never the plaintext.
            </p>
          </McpInfoModal>
        </h1>
        <p className="text-muted-foreground text-sm">
          Each MCP client needs an API key to connect. Keys control what the client can do via
          scopes — create one key per client, with only the permissions it needs.
        </p>
      </header>

      <McpKeysList initialKeys={keys} />
    </div>
  );
}
