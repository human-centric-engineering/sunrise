'use client';

/**
 * Renders one field value according to its `FieldSpec.display`.
 *
 * Phase 1: all variants are read-only. Phase 3 adds editable widgets
 * (`<Select>` for enum, `<Input>` for text/number, `<Switch>` for
 * boolean, `<Textarea>` for textarea) that fire `onChange` when the
 * admin edits the value via Modify mode.
 *
 * `rowContext` is the full sub-item row; used in Phase 3 to look up an
 * enum-by-field-key (e.g. an audit change row's `proposedValue` enum
 * depends on the row's `field` cell).
 */

import { Badge } from '@/components/ui/badge';
import type { FieldSpec } from '@/lib/orchestration/review-schema/types';

export interface ReviewFieldProps {
  field: FieldSpec;
  value: unknown;
  /** Full record the field belongs to. Used for cross-cell enum lookup. */
  rowContext?: Record<string, unknown>;
}

export function ReviewField({ field, value }: ReviewFieldProps) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground italic">—</span>;
  }

  switch (field.display) {
    case 'badge':
      return (
        <Badge variant="outline" className="text-[10px]">
          {safeText(value)}
        </Badge>
      );

    case 'pre':
      return (
        <pre className="bg-muted/30 max-w-md overflow-auto rounded p-1.5 text-[11px] leading-snug">
          {Array.isArray(value)
            ? value.map(safeText).join(', ')
            : typeof value === 'object'
              ? JSON.stringify(value, null, 2)
              : safeText(value)}
        </pre>
      );

    case 'textarea':
      return <p className="max-w-md text-xs leading-snug whitespace-pre-wrap">{safeText(value)}</p>;

    case 'boolean':
      return (
        <Badge variant={value ? 'default' : 'secondary'} className="text-[10px]">
          {value ? 'true' : 'false'}
        </Badge>
      );

    case 'number':
      return <span className="font-mono text-xs">{safeText(value)}</span>;

    case 'enum':
    case 'text':
    default:
      return <span className="text-xs">{safeText(value)}</span>;
  }
}

/**
 * Coerce an unknown value to a display string without triggering the
 * `[object Object]` lint. Primitives stringify directly; objects and
 * arrays JSON-encode (kept here so callers don't have to handle the
 * branching). Null and undefined are filtered out by the caller.
 */
function safeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
