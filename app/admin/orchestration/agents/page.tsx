import type { Metadata } from 'next';
import Link from 'next/link';

import { AgentsTable } from '@/components/admin/orchestration/agents-table';
import { FieldHelp } from '@/components/ui/field-help';
import { prisma } from '@/lib/db/client';
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

export default async function AgentsListPage() {
  let agents: AiAgent[];
  let meta: PaginationMeta;
  try {
    const [rows, total] = await Promise.all([
      prisma.aiAgent.findMany({ orderBy: { createdAt: 'desc' }, take: 25 }),
      prisma.aiAgent.count(),
    ]);
    agents = rows;
    meta = { page: 1, limit: 25, total, totalPages: Math.ceil(total / 25) || 1 };
  } catch (err) {
    logger.error('agents list page: initial fetch failed', err);
    agents = [];
    meta = EMPTY_META;
  }

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
