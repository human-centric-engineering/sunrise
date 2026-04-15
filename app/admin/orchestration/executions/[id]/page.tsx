import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ExecutionDetailView } from '@/components/admin/orchestration/execution-detail-view';
import { FieldHelp } from '@/components/ui/field-help';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { executionTraceSchema } from '@/lib/validations/orchestration';
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

export default async function ExecutionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession();
  const userId = session?.user?.id;

  let data: ExecutionResponse | null = null;

  try {
    if (userId) {
      const execution = await prisma.aiWorkflowExecution.findUnique({ where: { id } });
      if (execution && execution.userId === userId) {
        const trace = executionTraceSchema.parse(execution.executionTrace);
        data = {
          execution: {
            id: execution.id,
            workflowId: execution.workflowId,
            status: execution.status,
            totalTokensUsed: execution.totalTokensUsed,
            totalCostUsd: execution.totalCostUsd,
            budgetLimitUsd: execution.budgetLimitUsd ?? null,
            currentStep: execution.currentStep ? parseInt(execution.currentStep, 10) : null,
            inputData: execution.inputData,
            outputData: execution.outputData,
            errorMessage: execution.errorMessage,
            startedAt: execution.startedAt?.toISOString() ?? null,
            completedAt: execution.completedAt?.toISOString() ?? null,
            createdAt: execution.createdAt.toISOString(),
          },
          trace,
        };
      }
    }
  } catch (err) {
    logger.error('execution detail page: fetch failed', err, { id });
  }

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
              workflow succeeded or failed.
            </p>
          </FieldHelp>
        </h1>
      </header>

      <ExecutionDetailView execution={data.execution} trace={data.trace} />
    </div>
  );
}
