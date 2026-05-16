'use client';

/**
 * One item in a review section.
 *
 * State machine per item:
 *   - 'accept' (default) — included in payload as-is.
 *   - 'reject' — excluded from payload.
 *   - 'modify' — included with edited values from `overrides`.
 *
 * Modify mode unlocks editable inputs on fields that declare
 * `editable: true`. The "Modified" badge appears when overrides exist.
 *
 * For sections with sub-items (e.g. an audit-changes table), each
 * sub-row has its own state — the parent item's accept/reject controls
 * inclusion of the whole group but each individual change is toggled
 * separately.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, RotateCcw } from 'lucide-react';

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
  const decision = state?.decision ?? 'accept';
  const isRejected = decision === 'reject';
  const isModified =
    state && 'overrides' in state && state.overrides && Object.keys(state.overrides).length > 0;

  // Flat items support per-field Modify; nested items defer it to the
  // sub-row level.
  const hasEditableFlatFields =
    section.subItems === undefined && (section.fields ?? []).some((f) => f.editable && !f.readonly);

  const toggleReject = () => {
    if (section.subItems) {
      const current = state as NestedItemState | undefined;
      onChange({
        decision: isRejected ? 'accept' : 'reject',
        subItems: current?.subItems ?? {},
      });
    } else {
      onChange({
        decision: isRejected ? 'accept' : 'reject',
        // Preserve any overrides on toggle to reject — restoring later
        // brings them back rather than dropping the admin's edits.
        overrides: state && 'overrides' in state ? state.overrides : undefined,
      });
    }
  };

  const enterModifyMode = () => {
    // Modify is a UI affordance only — overrides are applied as the
    // user types. Click-to-enter pre-creates an empty overrides record
    // so unrelated edits in other rows don't get lost in render churn.
    if (section.subItems) return; // nested rows manage their own state
    const current = state as FlatItemState | undefined;
    onChange({
      decision: 'accept',
      overrides: current?.overrides ?? {},
    });
  };

  const revertOverrides = () => {
    if (section.subItems) return;
    onChange({ decision: 'accept' });
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
        {isModified && !isRejected && (
          <Badge variant="default" className="text-[10px]">
            Modified
          </Badge>
        )}
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
        {hasEditableFlatFields && !isRejected && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={isModified ? revertOverrides : enterModifyMode}
            title={isModified ? 'Revert modifications' : 'Modify proposed values'}
          >
            {isModified ? (
              <>
                <RotateCcw className="h-3 w-3" /> Revert
              </>
            ) : (
              <>
                <Pencil className="h-3 w-3" /> Modify
              </>
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant={isRejected ? 'outline' : 'ghost'}
          className={
            isRejected
              ? 'text-muted-foreground h-7 text-xs'
              : 'h-7 text-xs text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300'
          }
          onClick={toggleReject}
        >
          {isRejected ? 'Restore' : 'Reject'}
        </Button>
      </div>

      {expanded && (
        <div className="px-4 pr-4 pb-3 pl-12">
          {section.subItems ? (
            <NestedItemBody
              spec={section}
              item={item}
              state={state as NestedItemState | undefined}
              parentRejected={isRejected}
              onSubItemChange={(subKey, next) => {
                const current = (state as NestedItemState | undefined)?.subItems ?? {};
                onChange({
                  decision: state?.decision === 'reject' ? 'reject' : 'accept',
                  subItems: { ...current, [subKey]: next },
                });
              }}
            />
          ) : (
            <FlatItemBody
              fields={section.fields ?? []}
              item={item}
              overrides={state && 'overrides' in state && !isRejected ? state.overrides : undefined}
              onOverrideChange={(fieldKey, next) => {
                if (isRejected) return;
                const current = state && 'overrides' in state ? (state.overrides ?? {}) : {};
                onChange({
                  decision: 'accept',
                  overrides: { ...current, [fieldKey]: next },
                });
              }}
            />
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

function FlatItemBody({
  fields,
  item,
  overrides,
  onOverrideChange,
}: {
  fields: FieldSpec[];
  item: ResolvedItem;
  overrides: Record<string, unknown> | undefined;
  onOverrideChange: (fieldKey: string, next: unknown) => void;
}) {
  if (fields.length === 0) return null;
  const editing = overrides !== undefined;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
      {fields.map((field) => {
        const value = overrides && field.key in overrides ? overrides[field.key] : item[field.key];
        const isEditable = editing && field.editable === true && field.readonly !== true;
        return (
          <div key={field.key} className="contents">
            <dt className="text-muted-foreground py-0.5">{field.label}</dt>
            <dd className="py-0.5">
              <ReviewField
                field={field}
                value={value}
                rowContext={item}
                editable={isEditable}
                onChange={isEditable ? (next) => onOverrideChange(field.key, next) : undefined}
              />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function NestedItemBody({
  spec,
  item,
  state,
  parentRejected,
  onSubItemChange,
}: {
  spec: ReviewSectionSpec;
  item: ResolvedItem;
  state: NestedItemState | undefined;
  parentRejected: boolean;
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
            const rejected = rowState?.decision === 'reject' || parentRejected;
            const overrides =
              rowState && 'overrides' in rowState && !rejected ? rowState.overrides : undefined;
            const editing = overrides !== undefined;
            const isModified = overrides && Object.keys(overrides).length > 0;
            const hasEditable = sub.fields.some((f) => f.editable && !f.readonly);

            return (
              <tr key={key} className={`border-t ${rejected ? 'opacity-50' : ''}`}>
                {sub.fields.map((field) => {
                  const cellValue =
                    overrides && field.key in overrides ? overrides[field.key] : row[field.key];
                  const isEditable = editing && field.editable === true && field.readonly !== true;
                  return (
                    <td key={field.key} className="px-2 py-1.5 align-top">
                      <ReviewField
                        field={field}
                        value={cellValue}
                        rowContext={row}
                        editable={isEditable}
                        onChange={
                          isEditable
                            ? (next) => {
                                const current =
                                  rowState && 'overrides' in rowState
                                    ? (rowState.overrides ?? {})
                                    : {};
                                onSubItemChange(key, {
                                  decision: 'accept',
                                  overrides: { ...current, [field.key]: next },
                                });
                              }
                            : undefined
                        }
                      />
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {isModified && !rejected && (
                      <Badge variant="default" className="text-[9px]">
                        Modified
                      </Badge>
                    )}
                    {hasEditable && !rejected && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-[10px]"
                        title={editing ? 'Revert modifications' : 'Modify proposed values'}
                        onClick={() => {
                          if (editing) {
                            onSubItemChange(key, { decision: 'accept' });
                          } else {
                            onSubItemChange(key, {
                              decision: 'accept',
                              overrides:
                                rowState && 'overrides' in rowState
                                  ? (rowState.overrides ?? {})
                                  : {},
                            });
                          }
                        }}
                      >
                        {editing ? (
                          <RotateCcw className="h-3 w-3" />
                        ) : (
                          <Pencil className="h-3 w-3" />
                        )}
                      </Button>
                    )}
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
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
