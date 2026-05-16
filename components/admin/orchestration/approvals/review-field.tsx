'use client';

/**
 * Renders one field value according to its `FieldSpec.display`.
 *
 * When `editable` is true and `onChange` is provided, the field renders
 * an input widget instead of read-only text. Widget selection:
 *
 *   - `enumValues` (inline) or `enumValuesFrom` (named registry) or
 *     `enumValuesByFieldKey` (sibling-cell scoped, e.g. an audit change
 *     row's `proposedValue` enum depends on its `field` column) →
 *     `<Select>`.
 *   - `display: 'textarea'` → `<Textarea>`.
 *   - `display: 'number'` → numeric `<Input>`.
 *   - `display: 'boolean'` → `<Switch>`.
 *   - Otherwise → text `<Input>`.
 *
 * Read-only mode falls back to typed display variants (badge, pre,
 * inline text). Empty / null values render as a dash.
 */

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SourcesField } from '@/components/admin/orchestration/approvals/sources-field';
import { ENUM_BY_AUDIT_FIELD, NAMED_ENUMS } from '@/lib/orchestration/model-audit/enums';
import type { FieldSpec } from '@/lib/orchestration/review-schema/types';

export interface ReviewFieldProps {
  field: FieldSpec;
  /** Effective value: the override if modified, else the original. */
  value: unknown;
  /** Full record the field belongs to. Used for cross-cell enum lookup. */
  rowContext?: Record<string, unknown>;
  /**
   * When set, renders the field as an editable input. The caller owns
   * the override state and updates it on change.
   */
  editable?: boolean;
  onChange?: (next: unknown) => void;
}

export function ReviewField({ field, value, rowContext, editable, onChange }: ReviewFieldProps) {
  if (editable && onChange && !field.readonly) {
    return (
      <EditableField field={field} value={value} rowContext={rowContext} onChange={onChange} />
    );
  }

  // The 'sources' renderer handles its own empty/invalid states. Skip the
  // generic empty-value short-circuit so an empty array still routes
  // through SourcesField (which renders the same dash) rather than
  // falling through to the default text path.
  if (field.display === 'sources') {
    return <SourcesField value={value} />;
  }

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

function EditableField({
  field,
  value,
  rowContext,
  onChange,
}: Required<Pick<ReviewFieldProps, 'onChange'>> & {
  field: FieldSpec;
  value: unknown;
  rowContext?: Record<string, unknown>;
}) {
  const enumValues = resolveEnumValues(field, rowContext);

  if (enumValues) {
    return (
      <Select
        value={typeof value === 'string' ? value : ''}
        onValueChange={(next) => onChange(next)}
      >
        <SelectTrigger className="h-7 min-w-[10ch] text-xs">
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {enumValues.map((option) => (
            <SelectItem key={option} value={option} className="text-xs">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (field.display === 'textarea') {
    return (
      <Textarea
        className="min-h-[3rem] text-xs"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (field.display === 'number') {
    return (
      <Input
        type="number"
        className="h-7 w-32 text-xs"
        value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(null);
            return;
          }
          const num = Number(raw);
          onChange(Number.isFinite(num) ? num : raw);
        }}
      />
    );
  }

  if (field.display === 'boolean') {
    return <Switch checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked)} />;
  }

  // Free-text fallback
  return (
    <Input
      type="text"
      className="h-7 text-xs"
      value={typeof value === 'string' ? value : safeText(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Resolve an enum value list from any of three FieldSpec hints,
 * checked in order: `enumValues` (inline) > `enumValuesFrom` (named
 * registry) > `enumValuesByFieldKey` (per-row lookup based on a
 * sibling cell). Returns null when no enum applies — the caller falls
 * back to a text input.
 */
function resolveEnumValues(
  field: FieldSpec,
  rowContext?: Record<string, unknown>
): readonly string[] | null {
  if (field.enumValues && field.enumValues.length > 0) {
    return field.enumValues;
  }
  if (field.enumValuesFrom) {
    const list = NAMED_ENUMS[field.enumValuesFrom];
    if (list) return list;
  }
  if (field.enumValuesByFieldKey && rowContext) {
    const fieldKey = rowContext[field.enumValuesByFieldKey];
    if (typeof fieldKey === 'string') {
      const list = ENUM_BY_AUDIT_FIELD[fieldKey];
      if (list) return list;
    }
  }
  return null;
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
