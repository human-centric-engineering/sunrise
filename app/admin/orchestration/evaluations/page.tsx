import type { Metadata } from 'next';
import Link from 'next/link';

import { EvaluationsTable } from '@/components/admin/orchestration/evaluations-table';
import { ExperimentsList } from '@/components/admin/orchestration/experiments/experiments-list';
import { TestingTabs } from '@/components/admin/orchestration/testing-tabs';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Testing · AI Orchestration',
  description: 'Evaluate agents and run A/B experiments.',
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

async function getEvaluations(): Promise<{
  evaluations: EvaluationListItem[];
  meta: PaginationMeta;
}> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.EVALUATIONS}?page=1&limit=25`);
    if (!res.ok) return { evaluations: [], meta: EMPTY_META };
    const body = await parseApiResponse<EvaluationListItem[]>(res);
    if (!body.success) return { evaluations: [], meta: EMPTY_META };
    return {
      evaluations: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('evaluations list page: initial fetch failed', err);
    return { evaluations: [], meta: EMPTY_META };
  }
}

async function getAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AgentOption[]>(res);
    return body.success ? body.data : [];
  } catch {
    return [];
  }
}

export default async function TestingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ evaluations, meta }, agents, params] = await Promise.all([
    getEvaluations(),
    getAgents(),
    searchParams,
  ]);
  const defaultTab = params.tab === 'experiments' ? 'experiments' : 'evaluations';

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Testing</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Testing{' '}
          <FieldHelp title="Agent testing" contentClassName="w-96">
            <p>This page has two tools for measuring and improving your agents:</p>
            <p className="mt-2">
              <strong>Evaluations</strong> let you run a live chat session with a single agent. You
              review and annotate responses to measure quality and generate improvement suggestions.
            </p>
            <p className="mt-2">
              <strong>Experiments</strong> compare 2&ndash;5 variants of the same agent side by side
              to find the best prompt strategy.
            </p>
            <p className="mt-2 text-xs">
              Start with evaluations to establish a baseline, then use experiments to optimise.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Evaluate agent quality and run A/B experiments to find the best configurations.
        </p>
      </header>

      <TestingTabs
        defaultTab={defaultTab}
        evaluationsContent={
          <EvaluationsTable initialEvaluations={evaluations} initialMeta={meta} agents={agents} />
        }
        experimentsContent={<ExperimentsList />}
      />
    </div>
  );
}
