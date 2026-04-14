'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';

interface EmbeddingStatusBannerProps {
  total: number;
  embedded: number;
  hasActiveProvider: boolean;
}

/**
 * Banner shown when embedding coverage is incomplete.
 *
 * Displayed on pages that rely on vector search (Knowledge Base,
 * Advisor, Quiz) to tell the user that search may return limited
 * results until all chunks are embedded.
 */
export function EmbeddingStatusBanner({
  total,
  embedded,
  hasActiveProvider,
}: EmbeddingStatusBannerProps) {
  if (total === 0 || embedded >= total) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p>
          Vector search is {embedded === 0 ? 'unavailable' : 'partially available'}:{' '}
          <strong>
            {embedded} of {total}
          </strong>{' '}
          chunks are embedded.
          {!hasActiveProvider ? (
            <>
              {' '}
              <Link href="/admin/orchestration/providers" className="underline">
                Add an embedding provider
              </Link>{' '}
              (Voyage AI with a free tier, or OpenAI) and run <strong>Generate Embeddings</strong>{' '}
              on the{' '}
              <Link href="/admin/orchestration/knowledge" className="underline">
                Knowledge Base
              </Link>{' '}
              page to enable full search. Note: Anthropic (Claude) does not offer embeddings.
            </>
          ) : (
            <>
              {' '}
              Run <strong>Generate Embeddings</strong> on the{' '}
              <Link href="/admin/orchestration/knowledge" className="underline">
                Knowledge Base
              </Link>{' '}
              page to enable full search.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
