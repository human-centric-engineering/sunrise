'use client';

/**
 * Structured approval view.
 *
 * Dispatched from `approvals-table.tsx` when the paused workflow has a
 * `reviewSchema` attached to its `human_approval` step (currently:
 * `tpl-provider-model-audit`). Replaces the markdown wallpaper with a
 * per-section, per-item Accept / Reject form whose state projects into
 * the approve request's `approvalPayload`.
 *
 * Per-section graceful fallback: a section whose `source` fails to
 * resolve falls back to the markdown view for just that section, so a
 * partial trace doesn't blank-screen the admin.
 */

import { useMemo, useState } from 'react';
import { CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { MarkdownContent } from '@/components/admin/orchestration/markdown-or-raw-view';
import { ReviewSection } from '@/components/admin/orchestration/approvals/review-section';
import {
  buildApprovalPayload,
  gatherSectionItems,
  type ItemState,
  type ReviewSelectionState,
  type SectionData,
} from '@/lib/orchestration/review-schema/resolver';
import type { ReviewSchema } from '@/lib/orchestration/review-schema/types';
import type { ExecutionTraceEntry } from '@/types/orchestration';

export interface StructuredApprovalViewProps {
  trace: ExecutionTraceEntry[];
  schema: ReviewSchema;
  /** Fallback prompt for sections that fail to parse. */
  fallbackPrompt: string | null;
  /** Open the Approve dialog with this payload pre-set. */
  onRequestApprove: (approvalPayload: Record<string, unknown[]>) => void;
  onRequestReject: () => void;
  submitting?: boolean;
}

export function StructuredApprovalView({
  trace,
  schema,
  fallbackPrompt,
  onRequestApprove,
  onRequestReject,
  submitting,
}: StructuredApprovalViewProps) {
  const sectionsData: SectionData[] = useMemo(
    () => schema.sections.map((s) => gatherSectionItems(s, trace)),
    [schema, trace]
  );

  // Section state defaults: every item marked accept (admin only needs
  // to opt OUT of changes they disagree with). For sections with
  // nested sub-items, every sub-item is also accepted by default.
  const [selection, setSelection] = useState<ReviewSelectionState>(() =>
    initialSelection(sectionsData)
  );

  const summary = useMemo(
    () => summariseSelection(sectionsData, selection),
    [sectionsData, selection]
  );

  const handleSubmit = () => {
    const payload = buildApprovalPayload(schema, sectionsData, selection);
    onRequestApprove(payload);
  };

  const allParsedEmpty = sectionsData.every((s) => !s.error && s.items.length === 0);

  return (
    <div className="space-y-4">
      <header className="bg-background flex items-center justify-between rounded-md border p-3">
        <div className="flex items-center gap-3 text-sm">
          <Info className="text-muted-foreground h-4 w-4 shrink-0" />
          <p>
            <span className="font-medium">
              {summary.acceptedTotal} of {summary.totalCandidate}
            </span>{' '}
            change{summary.totalCandidate === 1 ? '' : 's'} will be applied on approve.{' '}
            <FieldHelp title="How this works">
              The audit produced proposed changes, new model entries, and deactivations across three
              sections below. Each row defaults to <em>accepted</em>; click reject on individual
              rows to skip them. Your selection becomes the workflow&apos;s approval payload.
            </FieldHelp>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={submitting}
            className="h-8 gap-1 text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
            onClick={onRequestReject}
          >
            <XCircle className="h-3.5 w-3.5" />
            Reject
          </Button>
          <Button
            size="sm"
            disabled={submitting || summary.acceptedTotal === 0}
            className="h-8 gap-1 bg-green-600 hover:bg-green-700"
            onClick={handleSubmit}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Approve selected
          </Button>
        </div>
      </header>

      {allParsedEmpty && (
        <div className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-sm">
          The audit produced no proposed changes, new models, or deactivations. Approve to record
          the no-op and complete the workflow.
        </div>
      )}

      {sectionsData.map((data) => {
        if (data.error) {
          return (
            <SectionFallback
              key={data.section.id}
              title={data.section.title}
              error={data.error}
              fallback={fallbackPrompt}
            />
          );
        }
        return (
          <ReviewSection
            key={data.section.id}
            section={data.section}
            items={data.items}
            state={selection[data.section.id]?.items ?? {}}
            onItemChange={(itemKey, next) => {
              setSelection((prev) => ({
                ...prev,
                [data.section.id]: {
                  items: { ...(prev[data.section.id]?.items ?? {}), [itemKey]: next },
                },
              }));
            }}
          />
        );
      })}
    </div>
  );
}

function SectionFallback({
  title,
  error,
  fallback,
}: {
  title: string;
  error: string;
  fallback: string | null;
}) {
  return (
    <section className="bg-background rounded-md border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant="outline" className="text-amber-700 dark:text-amber-400">
          fallback view
        </Badge>
      </div>
      <p className="text-muted-foreground mb-2 text-xs">
        Could not render structured view: {error}. Showing the workflow&apos;s markdown summary
        instead.
      </p>
      {fallback ? (
        <MarkdownContent content={fallback} className="text-sm" />
      ) : (
        <p className="text-muted-foreground text-xs">No fallback content available.</p>
      )}
    </section>
  );
}

function initialSelection(sectionsData: SectionData[]): ReviewSelectionState {
  const state: ReviewSelectionState = {};
  for (const data of sectionsData) {
    const items: Record<string, ItemState> = {};
    for (const item of data.items) {
      if (data.section.subItems) {
        items[item.__key] = { decision: 'accept', subItems: {} };
      } else {
        items[item.__key] = { decision: 'accept' };
      }
    }
    state[data.section.id] = { items };
  }
  return state;
}

interface SelectionSummary {
  acceptedTotal: number;
  totalCandidate: number;
}

function summariseSelection(
  sectionsData: SectionData[],
  selection: ReviewSelectionState
): SelectionSummary {
  let acceptedTotal = 0;
  let totalCandidate = 0;

  for (const data of sectionsData) {
    if (data.error) continue;
    const states = selection[data.section.id]?.items ?? {};

    for (const item of data.items) {
      const state = states[item.__key];
      if (data.section.subItems) {
        // For nested items, count each sub-item as a candidate change.
        const rawSubs = item[data.section.subItems.source.replace(/^item\./, '')];
        const subCount = Array.isArray(rawSubs) ? rawSubs.length : 0;
        totalCandidate += subCount;
        if (!state || state.decision === 'accept') {
          const nested =
            state && 'subItems' in state
              ? (state as { subItems: Record<string, ItemState> }).subItems
              : {};
          let accepted = subCount;
          for (const subState of Object.values(nested)) {
            if (subState && 'decision' in subState && subState.decision === 'reject') accepted--;
          }
          acceptedTotal += Math.max(0, accepted);
        }
      } else {
        totalCandidate += 1;
        if (!state || state.decision !== 'reject') acceptedTotal += 1;
      }
    }
  }

  return { acceptedTotal, totalCandidate };
}
