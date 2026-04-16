import type { Metadata } from 'next';
import Link from 'next/link';

import { AgentsTable } from '@/components/admin/orchestration/agents-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { AiAgentListItem } from '@/types/orchestration';
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
async function getAgents(): Promise<{ agents: AiAgentListItem[]; meta: PaginationMeta }> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=25`);
    if (!res.ok) return { agents: [], meta: EMPTY_META };
    const body = await parseApiResponse<AiAgentListItem[]>(res);
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
        <h1 className="text-2xl font-semibold">
          Agents{' '}
          <FieldHelp title="What are agents?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              An agent is a configured AI persona. It has a system prompt (personality and
              instructions), an LLM provider and model that powers it, and capabilities (tools) it
              can call. Think of it as a specialised AI assistant you design for a specific job.
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              When a user sends a message, the agent&apos;s LLM reads the system prompt, considers
              the conversation history, and generates a response. If it needs external data or
              actions, it calls capabilities — like looking up a database or sending an email — then
              continues reasoning with the result.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Create, duplicate, import/export, and test agents. Click an agent to edit its
              instructions, model, and capabilities.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Create, edit, duplicate, import/export, and test your AI agents.
        </p>
      </header>

      <AgentsTable initialAgents={agents} initialMeta={meta} />
    </div>
  );
}
