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
import type { PrivacyRefusalReason } from '@/lib/orchestration/llm/privacy-stage';
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

/** What the admin is told a refusal reason means. Never a value. */
const REFUSAL_TEXT: Record<PrivacyRefusalReason, string> = {
  content_blocked: 'personal data found (block mode)',
  detector_failed: 'a detector failed or ran out of time',
  embeddings_local_only: 'embedding refused: local embedding models only',
  app_init_failed: "the app's privacy adapters failed to load",
  core_install_failed: 'a built-in privacy adapter failed to load',
  settings_unreadable: 'the stored privacy mode is unreadable',
  policy_resolver_failed: 'a privacy policy resolver failed',
  stage_error: 'an internal error in the privacy layer',
};

function refusalText(reason: string): string {
  return Object.prototype.hasOwnProperty.call(REFUSAL_TEXT, reason)
    ? REFUSAL_TEXT[reason as PrivacyRefusalReason]
    : reason;
}

/** One line: the chat calls' counts, then the embedding calls', each only when there were any. */
function summaryText(summary: PrivacySummary): string {
  const parts: string[] = [];
  if (summary.calls > 0) {
    parts.push(`${countsText(summary.counts)} found across ${callsText(summary.calls)}`);
  }
  if (summary.embeddingCalls > 0) {
    parts.push(
      `embeddings: ${countsText(summary.embeddingCounts)} found across ${callsText(summary.embeddingCalls)}`
    );
  }
  if (parts.length === 0) parts.push('no call sent');
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
      {summary.refused && summary.refused.length > 0 && (
        <span className="text-red-700 dark:text-red-400" data-testid="privacy-refused">
          · refused: {summary.refused.map((r) => refusalText(r)).join('; ')}
        </span>
      )}
      {summary.unresolved !== undefined && summary.unresolved > 0 && (
        <span className="text-amber-700 dark:text-amber-400">
          · {summary.unresolved} placeholder{summary.unresolved === 1 ? '' : 's'} left unrestored
        </span>
      )}
      <FieldHelp title="Privacy counts">
        How many times each type of personal data was found in what was sent to a provider, across
        every call made here, tools, embeddings and any agent, chat turn or workflow it ran
        included. Each call resends the conversation so far, so a value that stays in the history is
        counted on every call that carried it, and again on a retry with another provider. The mode
        shown is the strictest any of those calls ran under: in detect a value went out as it was,
        in pseudonymise and redact a chat call carried a placeholder instead, and embeddings always
        go as they are. The values themselves are never stored. Degraded means a detector failed or
        ran out of time on a call, which went ahead without it. Refused means a call was stopped
        before it was sent, and why. A placeholder left unrestored is one the model wrote that no
        call had issued, shown as written.
      </FieldHelp>
    </div>
  );
}
