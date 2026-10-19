import type { Metadata } from 'next';
import Link from 'next/link';

import { EvaluationForm } from '@/components/admin/orchestration/evaluation-form';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';

export const metadata: Metadata = {
  title: 'New Evaluation · AI Orchestration',
  description: 'Create a new agent evaluation session.',
};

interface AgentOption {
  id: string;
  name: string;
}

export default async function NewEvaluationPage() {
  // The form cannot work without its agent list, so a failed load reaches the
  // error boundary rather than offering an empty dropdown (#518).
  const { data: agents } = await requireServerData<AgentOption[]>(
    `${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=100`
  );

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
