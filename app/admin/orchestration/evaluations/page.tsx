import type { Metadata } from 'next';
import Link from 'next/link';

import { EvaluationsTable } from '@/components/admin/orchestration/evaluations-table';
import { FieldHelp } from '@/components/ui/field-help';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Evaluations · AI Orchestration',
  description: 'Run and review agent evaluation sessions.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

interface EvaluationListItem {
  id: string;
  title: string;
  status: string;
  description?: string | null;
  agentId?: string | null;
  agent?: { id: string; name: string; slug: string } | null;
  _count?: { logs: number };
  createdAt: string;
}

interface AgentOption {
  id: string;
  name: string;
}

export default async function EvaluationsListPage() {
  let evaluations: EvaluationListItem[];
  let meta: PaginationMeta;
  let agents: AgentOption[];
  try {
    const [rows, total, agentRows] = await Promise.all([
      prisma.aiEvaluationSession.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 25,
        include: {
          agent: { select: { id: true, name: true, slug: true } },
          _count: { select: { logs: true } },
        },
      }),
      prisma.aiEvaluationSession.count(),
      prisma.aiAgent.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 100,
      }),
    ]);
    evaluations = rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    }));
    meta = { page: 1, limit: 25, total, totalPages: Math.ceil(total / 25) || 1 };
    agents = agentRows;
  } catch (err) {
    logger.error('evaluations list page: initial fetch failed', err);
    evaluations = [];
    meta = EMPTY_META;
    agents = [];
  }

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Evaluations</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Evaluations{' '}
          <FieldHelp title="What are evaluations?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              Evaluations let you systematically test how well your AI agents perform. You create an
              evaluation session, send a set of test prompts to an agent, then review and annotate
              each response.
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              1. <strong>Create a session</strong> — pick an agent and give the evaluation a title
              (e.g. &quot;Customer support edge cases&quot;).
            </p>
            <p>
              2. <strong>Run prompts</strong> — the system sends your test inputs to the agent and
              records each response.
            </p>
            <p>
              3. <strong>Annotate</strong> — review each response and mark it as correct, partially
              correct, or incorrect. Add notes explaining what went wrong.
            </p>
            <p>
              4. <strong>Insights</strong> — the annotations are summarised into improvement
              suggestions you can use to refine the agent&apos;s system instructions, capabilities,
              or knowledge base.
            </p>
            <p className="text-foreground mt-2 font-medium">When to use</p>
            <p>
              Run evaluations after changing an agent&apos;s instructions or capabilities to check
              for regressions, or before deploying an agent to production to verify it handles your
              key scenarios correctly.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Run agent evaluation sessions, annotate responses, and generate improvement insights.
        </p>
      </header>

      <EvaluationsTable initialEvaluations={evaluations} initialMeta={meta} agents={agents} />
    </div>
  );
}
