import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EvaluationRunner } from '@/components/admin/orchestration/evaluation-runner';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
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

export default async function EvaluationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getServerSession();
  const userId = session?.user?.id;

  let evaluation: EvaluationSession | null = null;
  try {
    if (userId) {
      const row = await prisma.aiEvaluationSession.findFirst({
        where: { id, userId },
        include: {
          agent: { select: { id: true, name: true, slug: true } },
        },
      });
      if (row) {
        evaluation = {
          id: row.id,
          title: row.title,
          description: row.description,
          status: row.status,
          summary: row.summary,
          improvementSuggestions: row.improvementSuggestions as string[] | null,
          agent: row.agent,
          createdAt: row.createdAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
          metadata: row.metadata as Record<string, unknown> | null,
        };
      }
    }
  } catch (err) {
    logger.error('evaluation detail page: fetch failed', err, { id });
  }

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
