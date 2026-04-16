import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EvaluationRunner } from '@/components/admin/orchestration/evaluation-runner';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

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

async function getEvaluation(id: string): Promise<EvaluationSession | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.evaluationById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<EvaluationSession>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('evaluation detail page: fetch failed', err, { id });
    return null;
  }
}

export default async function EvaluationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const evaluation = await getEvaluation(id);

  if (!evaluation) notFound();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
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
        <h1 className="text-2xl font-semibold">{evaluation.title}</h1>
        {evaluation.description && (
          <p className="text-muted-foreground text-sm">{evaluation.description}</p>
        )}
      </header>

      <EvaluationRunner evaluation={evaluation} />
    </div>
  );
}
