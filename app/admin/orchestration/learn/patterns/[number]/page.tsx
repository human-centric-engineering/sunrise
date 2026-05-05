import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { DiscussPatternButton } from '@/components/admin/orchestration/learn/discuss-pattern-button';
import { PatternDetailSections } from '@/components/admin/orchestration/learn/pattern-detail-sections';
import { PatternContent } from '@/components/admin/orchestration/learn/pattern-content';
import { RelatedPatterns } from '@/components/admin/orchestration/learn/related-patterns';
import { UsePatternButton } from '@/components/admin/orchestration/learn/use-pattern-button';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { PATTERN_ATTRIBUTION_LINE } from '@/lib/orchestration/knowledge/attribution';
import { extractRelatedPatterns } from '@/lib/orchestration/utils/extract-related-patterns';
import { parseOverviewContent } from '@/lib/orchestration/utils/parse-overview-content';
import { stripEmbeddingPrefix } from '@/lib/orchestration/utils/strip-embedding-prefix';
import type { AiKnowledgeChunk, PatternSummary } from '@/types/orchestration';

interface PatternDetail {
  patternName: string | null;
  chunks: AiKnowledgeChunk[];
  totalTokens: number;
}

interface PageProps {
  params: Promise<{ number: string }>;
}

const getPatternDetail = cache(async (num: number): Promise<PatternDetail | null> => {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(num));
    if (!res.ok) return null;
    const body = await parseApiResponse<PatternDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('pattern detail page: fetch failed', err);
    return null;
  }
});

async function getPatternNames(): Promise<Map<number, string>> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_PATTERNS);
    if (!res.ok) return new Map();
    const body = await parseApiResponse<PatternSummary[]>(res);
    if (!body.success) return new Map();
    return new Map(body.data.map((p) => [p.patternNumber, p.patternName]));
  } catch {
    return new Map();
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

  const [detail, patternNames] = await Promise.all([getPatternDetail(num), getPatternNames()]);

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

  // Sections shown open at the top as cards. The overview chunk is rendered
  // separately as a labelled caption under the page heading rather than as a
  // hero card — its body is just a list of software-engineering parallels and
  // doesn't warrant peer visual weight with the Summary.
  const HERO_SECTIONS = new Set(['tldr', 'summary']);

  const overviewChunk =
    detail.chunks.find((c) => (c.section ?? '').toLowerCase() === 'overview') ?? null;
  const overview = overviewChunk ? parseOverviewContent(overviewChunk.content) : null;

  const nonOverviewChunks = detail.chunks.filter(
    (c) => (c.section ?? '').toLowerCase() !== 'overview'
  );
  const heroChunks = nonOverviewChunks.filter((c) =>
    HERO_SECTIONS.has((c.section ?? '').toLowerCase())
  );
  const restChunks = nonOverviewChunks.filter(
    (c) => !HERO_SECTIONS.has((c.section ?? '').toLowerCase())
  );

  const relatedPatterns = extractRelatedPatterns(detail.chunks, num, patternNames).filter((p) =>
    patternNames.has(p.number)
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
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
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{detail.patternName}</h1>
          <div className="flex gap-2">
            <DiscussPatternButton patternNumber={num} />
            <UsePatternButton patternNumber={num} />
          </div>
        </div>
        {overview?.parallels && (
          <div className="text-muted-foreground mt-2 text-sm">
            <span className="font-medium">Software-engineering parallels:</span>{' '}
            {overview.parallels}
            {overview.example && <p className="mt-1 italic">{overview.example}</p>}
          </div>
        )}
      </header>

      {/* Hero sections — always visible in cards */}
      {heroChunks.map((chunk) => (
        <div key={chunk.id} className="bg-card rounded-lg border p-6">
          {chunk.section && (
            <h2 className="mb-3 text-lg font-medium">{chunk.section.replace(/_/g, ' ')}</h2>
          )}
          <PatternContent content={stripEmbeddingPrefix(chunk.content)} />
        </div>
      ))}

      {/* Related patterns — extracted from cross-references in content */}
      <RelatedPatterns patterns={relatedPatterns} />

      {/* Remaining sections — collapsible accordions */}
      {restChunks.length > 0 && <PatternDetailSections chunks={restChunks} />}

      <p className="text-muted-foreground border-border/50 mt-8 border-t pt-4 text-xs">
        {PATTERN_ATTRIBUTION_LINE}
      </p>
    </div>
  );
}
