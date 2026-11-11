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
  return entries.length === 0 ? 'nothing' : entries.map(([t, n]) => `${n} ${t}`).join(' · ');
}

function callsText(n: number): string {
  return `${n} ${n === 1 ? 'call' : 'calls'}`;
}

/** One line: the chat calls' counts, then the embedding calls', each only when there were any. */
function summaryText(summary: PrivacySummary): string {
  const parts: string[] = [];
  if (summary.calls > 0) {
    parts.push(`${countsText(summary.counts)} sent across ${callsText(summary.calls)}`);
  }
  if (summary.embeddingCalls > 0) {
    parts.push(
      `embeddings: ${countsText(summary.embeddingCounts)} sent across ${callsText(summary.embeddingCalls)}`
    );
  }
  return `Privacy (${summary.mode}): ${parts.join(' · ')}`;
}

export function PrivacyCounts({ summary }: { summary: PrivacySummary }) {
  return (
    <div
      className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
      data-testid="privacy-counts"
    >
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      <span>{summaryText(summary)}</span>
      {summary.degraded && (
        <span className="text-amber-700 dark:text-amber-400">
          · degraded{summary.failedAdapters ? ` (${summary.failedAdapters.join(', ')})` : ''}
        </span>
      )}
      <FieldHelp title="Privacy counts">
        How many times each type of personal data was sent to a provider, across every call made
        here, tools, embeddings and any agent, chat turn or workflow it ran included. Each call
        resends the conversation so far, so a value that stays in the history is counted on every
        call that carried it, and again on a retry with another provider. In detect mode nothing is
        changed; the values themselves are never stored. Degraded means a detector failed or ran out
        of time on a call, which went ahead without it.
      </FieldHelp>
    </div>
  );
}
