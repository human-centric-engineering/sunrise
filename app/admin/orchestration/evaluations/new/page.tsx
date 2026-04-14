import type { Metadata } from 'next';
import Link from 'next/link';

import { EvaluationForm } from '@/components/admin/orchestration/evaluation-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'New Evaluation · AI Orchestration',
  description: 'Create a new agent evaluation session.',
};

interface AgentOption {
  id: string;
  name: string;
}

async function getAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AgentOption[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('new evaluation page: agent fetch failed', err);
    return [];
  }
}

export default async function NewEvaluationPage() {
  const agents = await getAgents();

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
