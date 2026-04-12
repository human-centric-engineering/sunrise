import type { Metadata } from 'next';
import Link from 'next/link';

import { CapabilitiesTable } from '@/components/admin/orchestration/capabilities-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { AiCapability } from '@/types/prisma';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Capabilities · AI Orchestration',
  description:
    'Manage the tools your agents can call — function definitions, execution, and safety.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

/**
 * Admin — Capabilities list page (Phase 4 Session 4.3).
 *
 * Thin server component that pre-renders the first page of capabilities
 * via `serverFetch` and hands the result to `<CapabilitiesTable>` for
 * client-side search / filter / sort / pagination. Fetch failures never
 * throw — the table renders an empty state so the page is still usable.
 */
async function getCapabilities(): Promise<{
  capabilities: AiCapability[];
  meta: PaginationMeta;
}> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=25`);
    if (!res.ok) return { capabilities: [], meta: EMPTY_META };
    const body = await parseApiResponse<AiCapability[]>(res);
    if (!body.success) return { capabilities: [], meta: EMPTY_META };
    return {
      capabilities: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('capabilities list page: initial fetch failed', err);
    return { capabilities: [], meta: EMPTY_META };
  }
}

export default async function CapabilitiesListPage() {
  const { capabilities, meta } = await getCapabilities();

  // Derive the category filter's option list from whatever we already
  // have in hand. Categories are free-text on the backend, so this is
  // an eventually-consistent hint, not a canonical list.
  const availableCategories = Array.from(
    new Set(capabilities.map((c) => c.category).filter(Boolean))
  ).sort();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Capabilities</span>
        </nav>
        <h1 className="text-2xl font-semibold">Capabilities</h1>
        <p className="text-muted-foreground text-sm">
          Tools your agents can call — function definitions, execution handlers, and safety gates.
        </p>
      </header>

      <CapabilitiesTable
        initialCapabilities={capabilities}
        initialMeta={meta}
        availableCategories={availableCategories}
      />
    </div>
  );
}
