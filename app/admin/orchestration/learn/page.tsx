import type { Metadata } from 'next';
import Link from 'next/link';

import { LearningTabs } from '@/components/admin/orchestration/learn/learning-tabs';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { PatternSummary } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Learning · AI Orchestration',
  description: 'Explore agentic design patterns and test your knowledge.',
};

async function getPatterns(): Promise<PatternSummary[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_PATTERNS);
    if (!res.ok) return [];
    const body = await parseApiResponse<PatternSummary[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('learn page: pattern fetch failed', err);
    return [];
  }
}

export default async function LearnPage() {
  const patterns = await getPatterns();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Learning</span>
        </nav>
        <h1 className="text-2xl font-semibold">Learning</h1>
        <p className="text-muted-foreground text-sm">
          Explore agentic design patterns, get guidance from the advisor, and test your knowledge.
        </p>
      </header>

      <LearningTabs patterns={patterns} />
    </div>
  );
}
