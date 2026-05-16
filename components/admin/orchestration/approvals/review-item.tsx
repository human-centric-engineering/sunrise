'use client';

/**
 * One item in a review section.
 *
 * Header shows the templated title and any item-level badges; the
 * Accept / Reject toggle controls inclusion. The body expands the
 * item's fields (flat) or a sub-item table (nested). The body is open
 * by default — admins need to see the proposed change to decide, and
 * collapsing-by-default hides exactly the information they're judging.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ReviewField } from '@/components/admin/orchestration/approvals/review-field';
import {
  renderTitleTemplate,
  type FlatItemState,
  type ItemState,
  type NestedItemState,
  type ResolvedItem,
} from '@/lib/orchestration/review-schema/resolver';
import type {
  FieldSpec,
  ReviewSection as ReviewSectionSpec,
} from '@/lib/orchestration/review-schema/types';

export interface ReviewItemProps {
  section: ReviewSectionSpec;
  item: ResolvedItem;
  state: ItemState | undefined;
  onChange: (next: ItemState) => void;
}

export function ReviewItem({ section, item, state, onChange }: ReviewItemProps) {
  const [expanded, setExpanded] = useState(true);

  const title = renderTitleTemplate(section.itemTitle, item) || item.__key;
  const isRejected = state?.decision === 'reject';

  const toggleAccept = () => {
    if (section.subItems) {
      const current = state as NestedItemState | undefined;
      onChange({
        decision: isRejected ? 'accept' : 'reject',
        subItems: current?.subItems ?? {},
      });
    } else {
      onChange({ decision: isRejected ? 'accept' : 'reject' });
    }
  };

  return (
    <div className={isRejected ? 'opacity-60' : ''}>
      <div className="flex items-center gap-2 px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${isRejected ? 'line-through' : ''}`}>{title}</p>
        </div>
        {section.itemBadges?.map((badge) => {
          const value = item[badge.key];
          if (value === undefined || value === null || value === '') return null;
          const text = badgeText(value);
          if (text === '') return null;
          return (
            <Badge
              key={badge.key}
              variant="outline"
              className="text-[10px]"
              title={badge.label ?? badge.key}
            >
              {badge.label ? `${badge.label}: ${text}` : text}
            </Badge>
          );
        })}
        <Button
          size="sm"
          variant={isRejected ? 'outline' : 'ghost'}
          className={
            isRejected
              ? 'text-muted-foreground h-7 text-xs'
              : 'h-7 text-xs text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300'
          }
          onClick={toggleAccept}
        >
          {isRejected ? 'Restore' : 'Reject'}
        </Button>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pl-12">
          {section.subItems ? (
            <NestedItemBody
              spec={section}
              item={item}
              state={state as NestedItemState | undefined}
              onSubItemChange={(subKey, next) => {
                const current = (state as NestedItemState | undefined)?.subItems ?? {};
                onChange({
                  decision: state?.decision === 'reject' ? 'reject' : 'accept',
                  subItems: { ...current, [subKey]: next },
                });
              }}
            />
          ) : (
            <FlatItemBody fields={section.fields ?? []} item={item} />
          )}
        </div>
      )}
    </div>
  );
}

function badgeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

function FlatItemBody({ fields, item }: { fields: FieldSpec[]; item: ResolvedItem }) {
  if (fields.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
      {fields.map((field) => (
        <div key={field.key} className="contents">
          <dt className="text-muted-foreground py-0.5">{field.label}</dt>
          <dd className="py-0.5">
            <ReviewField field={field} value={item[field.key]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function NestedItemBody({
  spec,
  item,
  state,
  onSubItemChange,
}: {
  spec: ReviewSectionSpec;
  item: ResolvedItem;
  state: NestedItemState | undefined;
  onSubItemChange: (subKey: string, next: FlatItemState) => void;
}) {
  const sub = spec.subItems!;
  // Sub-items live under the parent at the path's last segment.
  const subKey = sub.source.replace(/^item\./, '');
  const rawRows = item[subKey];
  const rows = Array.isArray(rawRows) ? (rawRows as Array<Record<string, unknown>>) : [];

  if (rows.length === 0) {
    return <p className="text-muted-foreground text-xs">No proposed changes.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            {sub.fields.map((field) => (
              <th key={field.key} className="px-2 py-1.5 text-left font-medium">
                {field.label}
              </th>
            ))}
            <th className="px-2 py-1.5 text-right font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const rawKey = row[sub.itemKey];
            const key =
              typeof rawKey === 'string' || typeof rawKey === 'number'
                ? String(rawKey)
                : `sub-${idx}`;
            const rowState = state?.subItems?.[key];
            const rejected = rowState?.decision === 'reject';
            return (
              <tr key={key} className={`border-t ${rejected ? 'opacity-50' : ''}`}>
                {sub.fields.map((field) => (
                  <td key={field.key} className="px-2 py-1.5 align-top">
                    <ReviewField field={field} value={row[field.key]} rowContext={row} />
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className={
                      rejected
                        ? 'text-muted-foreground h-6 text-[11px]'
                        : 'h-6 text-[11px] text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300'
                    }
                    onClick={() =>
                      onSubItemChange(key, {
                        decision: rejected ? 'accept' : 'reject',
                      })
                    }
                  >
                    {rejected ? 'Restore' : 'Reject'}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
