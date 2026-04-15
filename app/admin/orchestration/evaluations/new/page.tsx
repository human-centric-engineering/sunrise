import type { Metadata } from 'next';
import Link from 'next/link';

import { EvaluationForm } from '@/components/admin/orchestration/evaluation-form';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'New Evaluation · AI Orchestration',
  description: 'Create a new agent evaluation session.',
};

interface AgentOption {
  id: string;
  name: string;
}

export default async function NewEvaluationPage() {
  let agents: AgentOption[];
  try {
    agents = await prisma.aiAgent.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 100,
    });
  } catch (err) {
    logger.error('new evaluation page: agent fetch failed', err);
    agents = [];
  }

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/evaluations" className="hover:underline">
          Evaluations
        </Link>
        {' / '}
        <span>New</span>
      </nav>

      <h1 className="text-2xl font-semibold">New Evaluation</h1>
      <p className="text-muted-foreground text-sm">
        Create an evaluation session to test and annotate an agent&apos;s responses.
      </p>

      <EvaluationForm agents={agents} />
    </div>
  );
}
