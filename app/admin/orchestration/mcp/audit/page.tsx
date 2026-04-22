import type { Metadata } from 'next';
import Link from 'next/link';

import { McpAuditLog } from '@/components/admin/orchestration/mcp/mcp-audit-log';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'MCP Audit Log · AI Orchestration',
  description: 'View all MCP server operations.',
};

interface AuditEntry {
  id: string;
  method: string;
  toolSlug: string | null;
  resourceUri: string | null;
  responseCode: string;
  errorMessage: string | null;
  durationMs: number;
  clientIp: string | null;
  createdAt: string;
  apiKey: { name: string; keyPrefix: string } | null;
}

interface AuditMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

async function getAuditLogs(): Promise<{ items: AuditEntry[]; meta: AuditMeta | null }> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.MCP_AUDIT}?page=1&limit=50`);
    if (!res.ok) return { items: [], meta: null };
    const body = await parseApiResponse<AuditEntry[]>(res);
    if (!body.success) return { items: [], meta: null };
    let meta: AuditMeta | null = null;
    if (body.meta && typeof body.meta === 'object') {
      const raw = body.meta as Record<string, unknown>;
      if (typeof raw.total === 'number' && typeof raw.page === 'number') {
        const limit = typeof raw.limit === 'number' ? raw.limit : 50;
        const totalPages =
          typeof raw.totalPages === 'number' ? raw.totalPages : Math.ceil(raw.total / limit);
        meta = {
          page: raw.page,
          limit,
          total: raw.total,
          totalPages,
        };
      }
    }
    return { items: body.data, meta };
  } catch (err) {
    logger.error('MCP audit page: fetch failed', err);
    return { items: [], meta: null };
  }
}

export default async function McpAuditPage() {
  const { items, meta } = await getAuditLogs();

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
          <span>Audit Log</span>
        </nav>
        <h1 className="text-2xl font-semibold">Audit Log</h1>
        <p className="text-muted-foreground text-sm">
          Every MCP operation is logged with client IP, duration, and result.
          {meta && meta.total > 0 && ` ${meta.total} total entries.`}
        </p>
      </header>

      <McpAuditLog initialEntries={items} initialMeta={meta} />
    </div>
  );
}
