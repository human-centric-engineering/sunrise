'use client';

/**
 * What the LLM privacy layer counted in a chat turn or a workflow step
 * (§127): per-type counts and how many calls were scanned, and the
 * confidential content it spotted, by group (§130). Counts and category names
 * only — the layer never stores a value it found, nor the text it classified.
 *
 * @see .context/privacy/llm-privacy-layer.md
 */
import { ShieldCheck } from 'lucide-react';

import { FieldHelp } from '@/components/ui/field-help';
import type { PrivacyRefusalReason } from '@/lib/orchestration/llm/privacy-stage';
import { SENSITIVITY_GROUPS, type CoreSensitivityCategory } from '@/lib/privacy/adapters/types';
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
  confidential_blocked: 'confidential content (block policy)',
  confidential_not_permitted:
    "confidential content its group's policy does not send to this provider",
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

/**
 * How a category reads to an admin, where its name spaced out is not enough.
 * Keyed by core's category names, so a renamed one fails the type-check; any
 * other category (an app's) reads as its name, spaced.
 */
const CATEGORY_TEXT = new Map<string, string>(
  Object.entries({
    hr_matter: 'HR matter',
    legal_matter: 'legal matter',
    personal_finance: 'personal finances',
    not_public: 'not public',
  } satisfies Partial<Record<CoreSensitivityCategory, string>>)
);

function categoryText(category: string): string {
  return CATEGORY_TEXT.get(category) ?? category.replaceAll('_', ' ');
}

/**
 * The confidential content found, by group, with what its policy did when
 * there is a decision (§130): "personal: health, HR matter (warned) ·
 * commercial: not public (refused)". A decision this version does not know
 * shows as written.
 */
function sensitivityText(
  sensitivity: NonNullable<PrivacySummary['sensitivity']>,
  confidential: PrivacySummary['confidential']
): string | null {
  const groups = SENSITIVITY_GROUPS.filter((g) => (sensitivity[g]?.length ?? 0) > 0).map((g) => {
    const decisions = confidential?.[g] ?? [];
    const categories = (sensitivity[g] ?? []).map(categoryText).join(', ');
    return decisions.length > 0
      ? `${g}: ${categories} (${decisions.join(', ')})`
      : `${g}: ${categories}`;
  });
  return groups.length === 0 ? null : groups.join(' · ');
}

/**
 * One line: the chat calls' counts, then the embedding calls', each only when
 * there were any. A summary that holds only confidential content (mode `off`,
 * or a local provider the masking skips) says nothing about calls.
 */
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
  if (parts.length === 0) {
    // Nothing was scanned for personal data. Only a refusal means nothing was
    // sent: a call classified for confidential content, or whose classifier
    // failed, went out (mode `off`, or a local provider the masking skips).
    if ((summary.refused?.length ?? 0) === 0) return `Privacy (${summary.mode})`;
    parts.push('no call sent');
  }
  return `Privacy (${summary.mode}): ${parts.join(' · ')}`;
}

export function PrivacyCounts({ summary }: { summary: PrivacySummary }) {
  const confidential = summary.sensitivity
    ? sensitivityText(summary.sensitivity, summary.confidential)
    : null;
  return (
    <div
      className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
      data-testid="privacy-counts"
    >
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      <span>{summaryText(summary)}</span>
      {confidential && (
        <span className="text-amber-700 dark:text-amber-400" data-testid="privacy-confidential">
          · confidential, {confidential}
        </span>
      )}
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
        go as they are. The values themselves are never stored. Degraded means a detector or a
        confidential-content classifier failed or ran out of time on a call, which went ahead
        without it. Refused means a call was stopped before it was sent, and why. A placeholder left
        unrestored is one the model wrote that no call had issued, shown as written. Confidential
        lists the kinds of confidential content spotted in what users wrote, in every privacy mode,
        whether the call was then sent or refused: personal (health, an HR or legal matter, and the
        other special categories) and commercial (unannounced plans, deals, restructuring, a
        business in trouble, a legal dispute). It is spotted by a phrase list, so it catches what is
        said outright and misses what is only implied. Like the counts, it covers everything a
        turn&apos;s calls carried, so a disclosure from an earlier turn shows again on each later
        turn that resent it. Beside each group is what its confidential-content policy did with the
        calls that held it, each that applied: allowed (sent), warned (sent, and the user told once)
        or refused (not sent). The text itself is never stored.
      </FieldHelp>
    </div>
  );
}
