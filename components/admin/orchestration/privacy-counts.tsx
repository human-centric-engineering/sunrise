'use client';

/**
 * What the LLM privacy layer counted in a chat turn or a workflow step
 * (§127): per-type counts and how many calls were scanned. Counts only —
 * the layer never stores a value it found.
 *
 * @see .context/privacy/llm-privacy-layer.md
 */
import { ShieldCheck } from 'lucide-react';

import { FieldHelp } from '@/components/ui/field-help';
import type { PrivacySummary } from '@/types/orchestration';

function countsText(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? 'nothing found' : entries.map(([t, n]) => `${n} ${t}`).join(' · ');
}

export function PrivacyCounts({ summary }: { summary: PrivacySummary }) {
  return (
    <div
      className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
      data-testid="privacy-counts"
    >
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      <span>
        Privacy ({summary.mode}): {countsText(summary.counts)} in {summary.calls}{' '}
        {summary.calls === 1 ? 'call' : 'calls'}
      </span>
      {summary.embeddingCalls > 0 && (
        <span>
          · embeddings: {countsText(summary.embeddingCounts)} in {summary.embeddingCalls}{' '}
          {summary.embeddingCalls === 1 ? 'call' : 'calls'}
        </span>
      )}
      {summary.degraded && (
        <span className="text-amber-700 dark:text-amber-400">
          · degraded{summary.failedAdapters ? ` (${summary.failedAdapters.join(', ')})` : ''}
        </span>
      )}
      <FieldHelp title="Privacy counts">
        What the LLM privacy layer found in the text sent to providers, by type, across every call
        made here, tools and embeddings included. In detect mode nothing is changed; the values
        themselves are never stored. Degraded means a detector failed or ran out of time on a call,
        which went ahead without it.
      </FieldHelp>
    </div>
  );
}
