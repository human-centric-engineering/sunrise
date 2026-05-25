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

export default async function TestingPage() {
  const [{ evaluations, meta }, agents] = await Promise.all([getEvaluations(), getAgents()]);

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <span>Testing</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
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

      <div className="bg-muted/30 flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
        <span className="text-muted-foreground">More:</span>
        <Link
          href="/admin/orchestration/evaluations/datasets"
          className="underline-offset-4 hover:underline"
        >
          Datasets
        </Link>
        <span className="text-muted-foreground/50">·</span>
        <Link
          href="/admin/orchestration/evaluations/runs"
          className="underline-offset-4 hover:underline"
        >
          Batch runs
        </Link>
        <span className="text-muted-foreground text-xs">
          (dataset-driven evaluations — Phase 1)
        </span>
      </div>

      <TestingTabs
        evaluationsContent={
          <EvaluationsTable initialEvaluations={evaluations} initialMeta={meta} agents={agents} />
        }
        experimentsContent={<ExperimentsList />}
      />
    </div>
  );
}
