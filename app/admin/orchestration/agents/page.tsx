import type { Metadata } from 'next';
import Link from 'next/link';

import { AgentsTable } from '@/components/admin/orchestration/agents-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { AiAgent } from '@/types/prisma';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Agents · AI Orchestration',
  description: 'Manage your AI agents — create, edit, duplicate, export, and test.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

/**
 * Admin — Agents list page (Phase 4 Session 4.2).
 *
 * Thin server component that pre-renders the first page of agents via
 * `serverFetch` and hands the result to `<AgentsTable>` for client-side
 * search / sort / pagination. Fetch failures never throw — the table
 * renders an empty-state banner so the page is still usable.
 */
async function getAgents(): Promise<{ agents: AiAgent[]; meta: PaginationMeta }> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=25`);
    if (!res.ok) return { agents: [], meta: EMPTY_META };
    const body = await parseApiResponse<AiAgent[]>(res);
    if (!body.success) return { agents: [], meta: EMPTY_META };
    return {
      agents: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('agents list page: initial fetch failed', err);
    return { agents: [], meta: EMPTY_META };
  }
}

export default async function AgentsListPage() {
  const { agents, meta } = await getAgents();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Agents</span>
        </nav>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-muted-foreground text-sm">
          Create, edit, duplicate, import/export, and test your AI agents.
        </p>
      </header>

      <AgentsTable initialAgents={agents} initialMeta={meta} />
    </div>
  );
}
