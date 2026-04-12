import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ExecutionDetailView } from '@/components/admin/orchestration/execution-detail-view';
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
  currentStep: number | null;
  inputData: unknown;
  outputData: unknown;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface ExecutionResponse {
  execution: ExecutionDetail;
  trace: ExecutionTraceEntry[];
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
          <span>Executions</span>
          {' / '}
          <span className="text-foreground">{id.slice(0, 8)}…</span>
        </nav>
        <h1 className="text-2xl font-semibold">Execution {id.slice(0, 8)}…</h1>
      </header>

      <ExecutionDetailView execution={data.execution} trace={data.trace} />
    </div>
  );
}
