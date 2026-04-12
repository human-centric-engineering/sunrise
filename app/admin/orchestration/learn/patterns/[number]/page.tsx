import type { Metadata } from 'next';
import Link from 'next/link';

import { PatternDetailSections } from '@/components/admin/orchestration/learn/pattern-detail-sections';
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

/**
 * Strip the embedding prefix ("PatternName — SectionName\n\n" or "PatternName\n\n")
 * that the chunker prepends for vector search context. The detail page already
 * displays the pattern name and section heading separately.
 */
function stripEmbeddingPrefix(content: string): string {
  // The chunker prepends "PatternName — SectionName\n\n" or "PatternName\n\n"
  // for embedding context. Strip whichever form matches the first line.
  const withDash = content.match(/^.+ — .+\n\n([\s\S]*)$/);
  if (withDash) return withDash[1];
  const plain = content.match(/^[^\n]+\n\n([\s\S]*)$/);
  if (plain) return plain[1];
  return content;
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

  // Sections shown open at the top as cards
  const HERO_SECTIONS = new Set(['overview', 'tldr', 'tl;dr summary']);

  const heroChunks = detail.chunks.filter((c) =>
    HERO_SECTIONS.has((c.section ?? '').toLowerCase())
  );
  const restChunks = detail.chunks.filter(
    (c) => !HERO_SECTIONS.has((c.section ?? '').toLowerCase())
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
        <h1 className="text-2xl font-semibold">{detail.patternName}</h1>
      </header>

      {/* Hero sections — always visible in cards */}
      {heroChunks.map((chunk) => (
        <div key={chunk.id} className="bg-card rounded-lg border p-6">
          {chunk.section && chunk.section.toLowerCase() !== 'overview' && (
            <h2 className="mb-3 text-lg font-medium">{chunk.section.replace(/_/g, ' ')}</h2>
          )}
          <PatternContent content={stripEmbeddingPrefix(chunk.content)} />
        </div>
      ))}

      {/* Remaining sections — collapsible accordions */}
      {restChunks.length > 0 && <PatternDetailSections chunks={restChunks} />}
    </div>
  );
}
