import type { Metadata } from 'next';
import Link from 'next/link';

import { EvaluationRunner } from '@/components/admin/orchestration/evaluation-runner';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';

export const metadata: Metadata = {
  title: 'Evaluation · AI Orchestration',
  description: 'Run or view an agent evaluation session.',
};

interface EvaluationSession {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  summary?: string | null;
  improvementSuggestions?: string[] | null;
  agent?: { id: string; name: string; slug: string } | null;
  createdAt: string;
  completedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export default async function EvaluationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // A 404 is a missing evaluation; any other failure reaches the error boundary.
  const { data: evaluation } = await requireServerData<EvaluationSession>(
    API.ADMIN.ORCHESTRATION.evaluationById(id),
    { notFound: true }
  );

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/evaluations" className="hover:underline">
          Evaluations
        </Link>
        {' / '}
        <span>{evaluation.title}</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="text-2xl font-semibold">{evaluation.title}</h1>
        {evaluation.description && (
          <p className="text-muted-foreground text-sm">{evaluation.description}</p>
        )}
      </header>

      <EvaluationRunner evaluation={evaluation} />
    </div>
  );
}
