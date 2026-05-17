/**
 * Pure helpers for the structured approval UI.
 *
 * - `resolveTemplatePath` follows `{{stepId.output.foo.bar}}` against
 *   trace entries. Strings whose content parses as JSON are unwrapped
 *   transparently — `llm_call` outputs are JSON-shaped strings in
 *   practice.
 * - `gatherSectionItems` runs a section's `source` (with the
 *   `__merge__:` operator for concatenating multiple paths) and returns
 *   an array of opaque item records.
 * - `renderTitleTemplate` substitutes `{{item.foo}}` placeholders in a
 *   section's `itemTitle` against one item.
 * - `buildApprovalPayload` projects per-section selection state into the
 *   shape the approve POST expects, keyed by section id.
 *
 * Nothing here imports React or talks to the network. The UI is a thin
 * shell around these primitives so they're easy to test in isolation.
 */

import type { ExecutionTraceEntry } from '@/types/orchestration';
import type {
  FieldSpec,
  ReviewSchema,
  ReviewSection,
} from '@/lib/orchestration/review-schema/types';

export type ResolvedItem = Record<string, unknown> & {
  /** Stable key for React + selection state. Read from `itemKey`. */
  __key: string;
};

export interface SectionData {
  section: ReviewSection;
  items: ResolvedItem[];
  /** Set when source resolution failed — callers fall back gracefully. */
  error?: string;
}

/**
 * Walk a `{{stepId.output.path.to.value}}` reference against the trace.
 * Returns `undefined` if any segment misses; that signals a missing
 * upstream output rather than an explicit `null`, which is preserved.
 *
 * String values that look like JSON (object/array) are JSON.parsed
 * before descent — `llm_call` outputs land as raw response strings. The
 * unwrap is local: only the value we're about to descend into is
 * parsed, not the whole trace.
 */
export function resolveTemplatePath(template: string, trace: ExecutionTraceEntry[]): unknown {
  const match = template.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (!match) return undefined;
  const segments = match[1].split('.');
  if (segments.length === 0) return undefined;

  const [stepId, ...rest] = segments;
  const entry = trace.find((e) => e.stepId === stepId);
  if (!entry) return undefined;

  // Convention: paths start with `<stepId>.output...`. Other prefixes
  // (e.g. `input`) aren't needed for the audit workflow yet — add them
  // explicitly when a use case arrives instead of silently supporting
  // them and inviting unbounded scope.
  if (rest[0] !== 'output') return undefined;

  let current: unknown = entry.output;
  for (const seg of rest.slice(1)) {
    current = step(current, seg);
    if (current === undefined) return undefined;
  }
  return current;
}

function step(value: unknown, segment: string): unknown {
  const unwrapped = maybeParseJson(value);
  if (unwrapped === null || typeof unwrapped !== 'object') return undefined;
  return (unwrapped as Record<string, unknown>)[segment];
}

function maybeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * Resolve a section's source array. Supports a single template path or
 * the `__merge__:` operator which concatenates multiple paths' arrays.
 * Returns `{ error }` for non-array, missing, or merge-with-non-array
 * results — the UI shows a per-section fallback to the markdown view.
 */
export function gatherSectionItems(
  section: ReviewSection,
  trace: ExecutionTraceEntry[]
): SectionData {
  const arrays = resolveSourceArrays(section.source, trace);
  if (typeof arrays === 'string') {
    return { section, items: [], error: arrays };
  }

  const flat = arrays.flat();
  const seenKeys = new Map<string, number>();
  const items: ResolvedItem[] = [];

  for (const raw of flat) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const rawKey = record[section.itemKey];
    const baseKey =
      typeof rawKey === 'string' || typeof rawKey === 'number'
        ? String(rawKey)
        : `item-${items.length}`;

    // Two sources merging into the same section can yield duplicate item
    // keys (e.g. chat-side and embedding-side deactivations of the same
    // model id). Disambiguate by suffix so React keys + selection state
    // stay 1:1 with items.
    const dupCount = seenKeys.get(baseKey) ?? 0;
    seenKeys.set(baseKey, dupCount + 1);
    const finalKey = dupCount === 0 ? baseKey : `${baseKey}#${dupCount}`;

    items.push({ ...record, __key: finalKey });
  }

  return { section, items };
}

function resolveSourceArrays(source: string, trace: ExecutionTraceEntry[]): unknown[][] | string {
  const mergePrefix = '__merge__:';
  const paths = source.startsWith(mergePrefix)
    ? source
        .slice(mergePrefix.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [source];

  if (paths.length === 0) return 'empty __merge__ source';

  const arrays: unknown[][] = [];
  for (const path of paths) {
    const resolved = maybeParseJson(resolveTemplatePath(path, trace));
    if (resolved === undefined) {
      return `path did not resolve: ${path}`;
    }
    if (!Array.isArray(resolved)) {
      return `path did not resolve to an array: ${path}`;
    }
    arrays.push(resolved);
  }
  return arrays;
}

/**
 * `{{item.modelName}}` style interpolation against a single item record.
 * Missing keys render as an empty string — the UI falls back to a
 * generic header when the resulting string is empty.
 */
export function renderTitleTemplate(template: string, item: ResolvedItem): string {
  return template.replace(/\{\{\s*item\.([\w.]+)\s*\}\}/g, (_, path: string) => {
    const segments = path.split('.');
    let current: unknown = item;
    for (const seg of segments) {
      if (current === null || typeof current !== 'object') return '';
      current = (current as Record<string, unknown>)[seg];
    }
    return stringifyPrimitive(current);
  });
}

/**
 * Stringify only safe primitive values. Anything else (objects, arrays)
 * renders as an empty string in the title template — they aren't useful
 * as inline titles, and the surrounding UI shows the full structure in
 * the item body.
 */
function stringifyPrimitive(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/**
 * Read a field value off an item (for flat items) or a sub-item record
 * (for nested rows). Sub-items inherit `item.changes` style nesting
 * which we don't recurse into — sub-item values are siblings of the
 * sub-item itself, not nested deeper.
 */
export function readFieldValue(item: ResolvedItem, field: FieldSpec): unknown {
  return item[field.key];
}

/**
 * Selection state coming back from the UI. The shape mirrors the
 * `ReviewSchema` and is what `buildApprovalPayload` projects into the
 * payload.
 *
 * For flat items: each item is `{ kind, overrides? }`.
 * For nested items: each parent item is `{ kind: 'accept' | 'reject' }`
 * and the sub-items live in `subItemStates[itemKey]`. A parent set to
 * `reject` drops the whole item; a parent set to `accept` includes only
 * the sub-items individually marked accept/modify.
 */
export type ItemDecision = 'accept' | 'reject' | 'modify';

export interface FlatItemState {
  decision: ItemDecision;
  /** Modified field values, keyed by `FieldSpec.key`. Only set when decision === 'modify'. */
  overrides?: Record<string, unknown>;
}

export interface NestedItemState {
  /** Whether the parent is included at all. Default 'accept'. */
  decision: 'accept' | 'reject';
  subItems: Record<string, FlatItemState>;
}

export type ItemState = FlatItemState | NestedItemState;

export interface SectionState {
  /** Keyed by `ResolvedItem.__key`. */
  items: Record<string, ItemState>;
}

export type ReviewSelectionState = Record<string, SectionState>;

/**
 * Project selection state into the request body's `approvalPayload`,
 * keyed by section id. Each section id becomes a top-level key.
 *
 * - Flat sections produce an array of accepted items (with overrides
 *   applied), filtering out rejected items.
 * - Nested sections produce an array of parents, each filtered to its
 *   accepted sub-items. Parents with no accepted sub-items are dropped.
 */
export function buildApprovalPayload(
  schema: ReviewSchema,
  sectionsData: SectionData[],
  selection: ReviewSelectionState
): Record<string, unknown[]> {
  const payload: Record<string, unknown[]> = {};

  for (const section of schema.sections) {
    const data = sectionsData.find((d) => d.section.id === section.id);
    if (!data) {
      payload[section.id] = [];
      continue;
    }

    const sectionSelection = selection[section.id]?.items ?? {};

    if (section.subItems) {
      payload[section.id] = projectNested(section, data.items, sectionSelection);
    } else {
      payload[section.id] = projectFlat(section, data.items, sectionSelection);
    }
  }

  return payload;
}

function projectFlat(
  section: ReviewSection,
  items: ResolvedItem[],
  itemStates: Record<string, ItemState>
): unknown[] {
  const accepted: unknown[] = [];
  for (const item of items) {
    const state = itemStates[item.__key];
    // Default: accept. An unsubmitted state means the admin hasn't
    // touched the row; opt-in rejection prevents accidental drops when
    // a section renders dozens of items the admin scrolled past.
    const decision: ItemDecision = state && 'decision' in state ? state.decision : 'accept';
    if (decision === 'reject') continue;

    // Overrides apply whenever they're set on an accepted item. There's
    // no separate 'modify' decision in the wire shape — overrides
    // present == admin edited the row.
    const overrides = state && 'overrides' in state ? state.overrides : undefined;
    const projected: Record<string, unknown> = stripInternal(item);
    if (overrides) {
      for (const [k, v] of Object.entries(overrides)) {
        if (isFieldEditable(section.fields, k)) {
          projected[k] = v;
        }
      }
    }
    accepted.push(projected);
  }
  return accepted;
}

function projectNested(
  section: ReviewSection,
  items: ResolvedItem[],
  itemStates: Record<string, ItemState>
): unknown[] {
  const subSpec = section.subItems!;
  const accepted: unknown[] = [];

  // Sub-items live under the parent at the path's last segment
  // (e.g. `item.changes` → `changes`).
  const subItemsKey = subSpec.source.replace(/^item\./, '');

  for (const item of items) {
    const rawState = itemStates[item.__key];
    const state = rawState && 'subItems' in rawState ? rawState : undefined;
    if (state?.decision === 'reject') continue;

    const rawSubs = item[subItemsKey];
    const subItemsRaw: unknown[] = Array.isArray(rawSubs) ? rawSubs : [];

    const acceptedSubs: unknown[] = [];
    for (let i = 0; i < subItemsRaw.length; i++) {
      const raw = subItemsRaw[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const rawKey = record[subSpec.itemKey];
      const subKey =
        typeof rawKey === 'string' || typeof rawKey === 'number' ? String(rawKey) : `sub-${i}`;
      const subState = state?.subItems?.[subKey];
      const decision: ItemDecision = subState?.decision ?? 'accept';
      if (decision === 'reject') continue;

      const subProjected: Record<string, unknown> = { ...record };
      if (subState?.overrides) {
        for (const [k, v] of Object.entries(subState.overrides)) {
          if (isFieldEditable(subSpec.fields, k)) {
            subProjected[k] = v;
          }
        }
      }
      acceptedSubs.push(subProjected);
    }

    if (acceptedSubs.length === 0) continue;

    const parentProjected = stripInternal(item);
    parentProjected[subItemsKey] = acceptedSubs;
    accepted.push(parentProjected);
  }

  return accepted;
}

function stripInternal(item: ResolvedItem): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === '__key') continue;
    out[k] = v;
  }
  return out;
}

function isFieldEditable(fields: FieldSpec[] | undefined, key: string): boolean {
  if (!fields) return false;
  const spec = fields.find((f) => f.key === key);
  return Boolean(spec && spec.editable && !spec.readonly);
}
