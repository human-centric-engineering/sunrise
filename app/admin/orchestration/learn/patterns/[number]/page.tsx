import type { Metadata } from 'next';
import Link from 'next/link';

import { PatternContent } from '@/components/admin/orchestration/learn/pattern-content';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { AiKnowledgeChunk } from '@/types/orchestration';

interface PatternDetail {
  patternName: string | null;
  chunks: AiKnowledgeChunk[];
  totalTokens: number;
}

interface PageProps {
  params: Promise<{ number: string }>;
}

async function getPatternDetail(num: number): Promise<PatternDetail | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(num));
    if (!res.ok) return null;
    const body = await parseApiResponse<PatternDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('pattern detail page: fetch failed', err);
    return null;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { number: rawNum } = await params;
  const num = parseInt(rawNum, 10);
  if (isNaN(num)) return { title: 'Pattern Not Found · AI Orchestration' };

  const detail = await getPatternDetail(num);
  return {
    title: detail?.patternName
      ? `${detail.patternName} · Learning · AI Orchestration`
      : 'Pattern Not Found · AI Orchestration',
  };
}

export default async function PatternDetailPage({ params }: PageProps) {
  const { number: rawNum } = await params;
  const num = parseInt(rawNum, 10);

  if (isNaN(num)) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground">Invalid pattern number.</p>
        <Link href="/admin/orchestration/learn" className="text-sm underline">
          Back to Learning
        </Link>
      </div>
    );
  }

  const detail = await getPatternDetail(num);

  if (!detail || detail.chunks.length === 0) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground">Pattern not found.</p>
        <Link href="/admin/orchestration/learn" className="text-sm underline">
          Back to Learning
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <Link href="/admin/orchestration/learn" className="hover:underline">
            Learning
          </Link>
          {' / '}
          <span>{detail.patternName}</span>
        </nav>
        <h1 className="text-2xl font-semibold">{detail.patternName}</h1>
      </header>

      <div className="space-y-8">
        {detail.chunks.map((chunk) => (
          <section key={chunk.id}>
            {chunk.section && (
              <h2 className="mb-3 text-lg font-medium capitalize">
                {chunk.section.replace(/_/g, ' ')}
              </h2>
            )}
            <PatternContent content={chunk.content} />
          </section>
        ))}
      </div>
    </div>
  );
}
