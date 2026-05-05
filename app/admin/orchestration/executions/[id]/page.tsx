import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  ExecutionDetailView,
  type TraceCostEntryRow,
} from '@/components/admin/orchestration/execution-detail-view';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { ExecutionTraceEntry } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Execution · AI Orchestration',
  description: 'View workflow execution details and step trace.',
};

interface ExecutionDetail {
  id: string;
  workflowId: string;
  status: string;
  totalTokensUsed: number;
  totalCostUsd: number;
  budgetLimitUsd: number | null;
  currentStep: string | null;
  inputData: unknown;
  outputData: unknown;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  workflow: { id: string; name: string };
}

interface ExecutionResponse {
  execution: ExecutionDetail;
  trace: ExecutionTraceEntry[];
  costEntries?: TraceCostEntryRow[];
}

async function getExecution(id: string): Promise<ExecutionResponse | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.executionById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<ExecutionResponse>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('execution detail page: fetch failed', err, { id });
    return null;
  }
}

export default async function ExecutionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getExecution(id);

  if (!data) notFound();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <Link href="/admin/orchestration/executions" className="hover:underline">
            Executions
          </Link>
          {' / '}
          <span className="text-foreground">{id.slice(0, 8)}…</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Execution {id.slice(0, 8)}…{' '}
          <FieldHelp title="What is an execution?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              An execution is a single run of a workflow. It records every step the engine processed
              — inputs, outputs, tokens, cost, and errors. Think of a workflow as a blueprint and an
              execution as one run of that blueprint.
            </p>
            <p className="text-foreground mt-2 font-medium">How to read it</p>
            <p>
              The trace shows steps in order. Each step displays its type, the data it received,
              what it produced, and how long it took. Failed steps include the error message and
              which step in the chain broke.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Inspect the step-by-step trace, see total cost and token usage, and diagnose where a
              workflow succeeded, failed, or was cancelled.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Workflow:{' '}
          <Link
            href={`/admin/orchestration/workflows/${data.execution.workflowId}`}
            className="hover:underline"
          >
            {data.execution.workflow.name}
          </Link>
        </p>
      </header>

      <ExecutionDetailView
        execution={data.execution}
        trace={data.trace}
        costEntries={data.costEntries}
      />
    </div>
  );
}
