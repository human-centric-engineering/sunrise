'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';

interface EmbeddingStatusBannerProps {
  total: number;
  embedded: number;
  hasActiveProvider: boolean;
  /**
   * Why embedding is unavailable, when it is. Optional so existing callers
   * keep compiling; without it the banner falls back to the "add a provider"
   * remedy, which is right for a fresh install and wrong for the other two.
   */
  providerState?: 'ok' | 'none_configured' | 'none_permitted' | 'unknown';
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
  providerState,
}: EmbeddingStatusBannerProps) {
  if (total === 0 || embedded >= total) return null;

  // The remedy has to match the reason. Telling an operator whose policy
  // refuses every provider to "add an embedding provider" sends them to add
  // rows that are already there and never mentions the rule — the exact
  // mistake `NoEligibleProviderError` exists to keep the runtime from making.
  const state = providerState ?? (hasActiveProvider ? 'ok' : 'none_configured');

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
          {state === 'none_permitted' ? (
            <>
              {' '}
              An embedding provider is configured, but this deployment&rsquo;s provider policy
              permits none of them, so embedding cannot run. Adding another provider will not help —
              the rule itself has to allow one (see <code>lib/app/llm-providers.ts</code>).
            </>
          ) : state === 'unknown' ? (
            <>
              {' '}
              We could not check whether an embedding provider is available — this is a temporary
              failure, not a verdict. Reload to try again; the chunk counts above are still
              accurate.
            </>
          ) : state === 'none_configured' ? (
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
