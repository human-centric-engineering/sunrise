import type { Metadata } from 'next';
import Link from 'next/link';

import { McpAuditLog } from '@/components/admin/orchestration/mcp/mcp-audit-log';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';

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

function toAuditMeta(raw: unknown): AuditMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  if (!('total' in raw) || typeof raw.total !== 'number') return null;
  if (!('page' in raw) || typeof raw.page !== 'number') return null;
  const limit = 'limit' in raw && typeof raw.limit === 'number' ? raw.limit : 50;
  const totalPages =
    'totalPages' in raw && typeof raw.totalPages === 'number'
      ? raw.totalPages
      : Math.ceil(raw.total / limit);
  return { page: raw.page, limit, total: raw.total, totalPages };
}

/** A failed load throws to the admin error boundary rather than an empty log (#518). */
async function getAuditLogs(): Promise<{ items: AuditEntry[]; meta: AuditMeta | null }> {
  const { data, meta } = await requireServerData<AuditEntry[]>(
    `${API.ADMIN.ORCHESTRATION.MCP_AUDIT}?page=1&limit=50`
  );
  return { items: data, meta: toAuditMeta(meta) };
}

export default async function McpAuditPage() {
  const { items, meta } = await getAuditLogs();

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
        <span>Audit Log</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
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
