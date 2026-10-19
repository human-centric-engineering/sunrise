import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { DiscussPatternButton } from '@/components/admin/orchestration/learn/discuss-pattern-button';
import { PatternDetailSections } from '@/components/admin/orchestration/learn/pattern-detail-sections';
import { PatternContent } from '@/components/admin/orchestration/learn/pattern-content';
import { RelatedPatterns } from '@/components/admin/orchestration/learn/related-patterns';
import { UsePatternButton } from '@/components/admin/orchestration/learn/use-pattern-button';
import { API } from '@/lib/api/endpoints';
import { loadServerData, ServerLoadError } from '@/lib/api/server-load';
import { PATTERN_ATTRIBUTION_LINE } from '@/lib/orchestration/knowledge/attribution';
import { extractRelatedPatterns } from '@/lib/orchestration/utils/extract-related-patterns';
import { parseOverviewContent } from '@/lib/orchestration/utils/parse-overview-content';
import { stripEmbeddingPrefix } from '@/lib/orchestration/utils/strip-embedding-prefix';
import { getPatternParamSchema } from '@/lib/validations/orchestration';
import type { AiKnowledgeChunk, PatternSummary } from '@/types/orchestration';

interface PatternDetail {
  patternName: string | null;
  chunks: AiKnowledgeChunk[];
  totalTokens: number;
}

interface PageProps {
  params: Promise<{ number: string }>;
}

/**
 * Shared by `generateMetadata` and the page. The API answers 404 for a pattern
 * with no chunks, which the page renders as "Pattern not found"; any other
 * failure is the page's to throw (#518).
 */
const getPatternDetail = cache((num: number) =>
  loadServerData<PatternDetail>(API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(num), {
    expected: [404],
  })
);

/** Pattern names for the related-patterns strip, or `null` when they could not be loaded. */
async function getPatternNames(): Promise<Map<number, string> | null> {
  const result = await loadServerData<PatternSummary[]>(API.ADMIN.ORCHESTRATION.KNOWLEDGE_PATTERNS);
  if (!result.ok) return null;
  return new Map(result.data.map((p) => [p.patternNumber, p.patternName]));
}

/**
 * The pattern number, or `null` when the API would reject it. Checked with the
 * route's own schema: a number it answers 400 (below 1, not an integer, past
 * the safe-integer range) would otherwise reach the load as a failure, and the
 * error page's "Try again" could never succeed.
 */
function parsePatternNumber(raw: string): number | null {
  const parsed = getPatternParamSchema.safeParse({ number: raw });
  return parsed.success ? parsed.data.number : null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { number: rawNum } = await params;
  const num = parsePatternNumber(rawNum);
  if (num === null) return { title: 'Pattern Not Found · AI Orchestration' };

  const result = await getPatternDetail(num);
  const detail = result.ok ? result.data : null;
  return {
    title: detail?.patternName
      ? `${detail.patternName} · Learning · AI Orchestration`
      : 'Pattern Not Found · AI Orchestration',
  };
}

export default async function PatternDetailPage({ params }: PageProps) {
  const { number: rawNum } = await params;
  const num = parsePatternNumber(rawNum);

  if (num === null) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground">Invalid pattern number.</p>
        <Link href="/admin/orchestration/learn" className="text-sm underline">
          Back to Learning
        </Link>
      </div>
    );
  }

  const [result, patternNames] = await Promise.all([getPatternDetail(num), getPatternNames()]);

  // Only a 404 is a missing pattern; any other failure reaches the error boundary.
  if (!result.ok && result.failure.kind === 'failed') {
    throw new ServerLoadError(
      API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(num),
      result.failure
    );
  }
  const detail = result.ok ? result.data : null;

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

  const relatedPatterns = patternNames
    ? extractRelatedPatterns(detail.chunks, num, patternNames).filter((p) =>
        patternNames.has(p.number)
      )
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
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

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
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
      {relatedPatterns ? (
        <RelatedPatterns patterns={relatedPatterns} />
      ) : (
        <LoadFailedNotice what="related patterns" />
      )}

      {/* Remaining sections — collapsible accordions */}
      {restChunks.length > 0 && <PatternDetailSections chunks={restChunks} />}

      <p className="text-muted-foreground border-border/50 mt-8 border-t pt-4 text-xs">
        {PATTERN_ATTRIBUTION_LINE}
      </p>
    </div>
  );
}
