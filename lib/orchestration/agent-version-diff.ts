/**
 * agent-version-diff — pure helpers for the agent version-history viewer.
 *
 * `diffAgentSnapshots(after, before)` produces an ordered list of
 * field-level changes between two versioned snapshots. The history UI
 * uses this to render a Before → After table inside each expanded row.
 *
 * Snapshots are the JSON blobs persisted on `AiAgentVersion.snapshot`
 * — see `app/api/v1/admin/orchestration/agents/[id]/route.ts` for the
 * shape we compare against. We deliberately accept `Record<string,
 * unknown>` rather than a strict type so the helper survives future
 * snapshot extensions without a compile break on the UI side.
 */

/** Human-readable labels for the fields we expect to see in a snapshot. */
const FIELD_LABELS: Record<string, string> = {
  systemInstructions: 'System instructions',
  model: 'Model',
  provider: 'Provider',
  fallbackProviders: 'Fallback providers',
  temperature: 'Temperature',
  maxTokens: 'Max output tokens',
  topicBoundaries: 'Topic boundaries',
  brandVoiceInstructions: 'Brand voice',
  metadata: 'Metadata',
  knowledgeCategories: 'Knowledge categories',
  rateLimitRpm: 'Rate limit (req/min)',
  visibility: 'Visibility',
  inputGuardMode: 'Input guard',
  outputGuardMode: 'Output guard',
  citationGuardMode: 'Citation guard',
  maxHistoryTokens: 'Max history tokens',
  retentionDays: 'Retention (days)',
  providerConfig: 'Provider config',
  monthlyBudgetUsd: 'Monthly budget (USD)',
  enableVoiceInput: 'Voice input',
  enableImageInput: 'Image input',
  enableDocumentInput: 'Document input',
};

/**
 * Whitelist of snapshot-shape fields. Used to extract the snapshot
 * subset from a live `AiAgent` row, so the diff against the newest
 * version row doesn't surface non-versioned columns like `name`,
 * `slug`, or `createdAt` as spurious "changes". Keep in sync with
 * the snapshot writer in
 * `app/api/v1/admin/orchestration/agents/[id]/route.ts`.
 */
export const SNAPSHOT_FIELDS = [
  'systemInstructions',
  'model',
  'provider',
  'fallbackProviders',
  'temperature',
  'maxTokens',
  'topicBoundaries',
  'brandVoiceInstructions',
  'metadata',
  'knowledgeCategories',
  'rateLimitRpm',
  'visibility',
  'inputGuardMode',
  'outputGuardMode',
  'citationGuardMode',
  'maxHistoryTokens',
  'retentionDays',
  'providerConfig',
  'monthlyBudgetUsd',
  'enableVoiceInput',
  'enableImageInput',
  'enableDocumentInput',
] as const;

export function extractSnapshotFromAgent(agent: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_FIELDS) {
    if (k in agent) out[k] = agent[k];
  }
  return out;
}

/** Stable display order: most-meaningful fields first. */
const FIELD_ORDER: string[] = [
  'model',
  'provider',
  'fallbackProviders',
  'systemInstructions',
  'temperature',
  'maxTokens',
  'maxHistoryTokens',
  'monthlyBudgetUsd',
  'rateLimitRpm',
  'retentionDays',
  'visibility',
  'inputGuardMode',
  'outputGuardMode',
  'citationGuardMode',
  'topicBoundaries',
  'brandVoiceInstructions',
  'knowledgeCategories',
  'enableVoiceInput',
  'enableImageInput',
  'enableDocumentInput',
  'providerConfig',
  'metadata',
];

export interface FieldChange {
  /** Raw snapshot key, e.g. `systemInstructions`. */
  field: string;
  /** Display label, e.g. "System instructions". */
  label: string;
  /** The value in the older snapshot (or `null` if this is the first version). */
  before: unknown;
  /** The value in the newer snapshot. */
  after: unknown;
}

export function labelForField(field: string): string {
  // Fallback for unknown keys: camelCase → "Camel case". Better than
  // showing the raw key, and graceful if the snapshot grows new fields.
  return (
    FIELD_LABELS[field] ??
    field
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase())
      .trim()
  );
}

/**
 * Deep-equality check for snapshot values. Snapshots come from the
 * same code path on both sides, so JSON-stringify equality is enough:
 * keys land in the same order from the writing side, and the values
 * are restricted to JSON-serialisable primitives, arrays, and plain
 * objects.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Produce the ordered diff between two snapshots.
 *
 * - `before === null` means `after` is the initial version: every
 *   field is reported as a change (before: null).
 * - The union of keys is considered so a field added or removed in
 *   either snapshot is surfaced rather than silently dropped.
 * - Unchanged fields are omitted from the result.
 */
export function diffAgentSnapshots(
  after: Record<string, unknown>,
  before: Record<string, unknown> | null
): FieldChange[] {
  const beforeObj = before ?? {};
  const keys = new Set<string>([...Object.keys(beforeObj), ...Object.keys(after)]);

  const changes: FieldChange[] = [];
  for (const key of keys) {
    const a = after[key];
    const b = beforeObj[key];
    if (before !== null && valuesEqual(a, b)) continue;
    changes.push({
      field: key,
      label: labelForField(key),
      before: before === null ? null : b,
      after: a,
    });
  }

  changes.sort((x, y) => {
    const xi = FIELD_ORDER.indexOf(x.field);
    const yi = FIELD_ORDER.indexOf(y.field);
    // Known fields by FIELD_ORDER, unknown alphabetically at the end.
    if (xi === -1 && yi === -1) return x.field.localeCompare(y.field);
    if (xi === -1) return 1;
    if (yi === -1) return -1;
    return xi - yi;
  });

  return changes;
}

/**
 * Render a snapshot value as a short display string for the diff
 * table. Long-form rendering (e.g. multiline `systemInstructions`)
 * is the caller's responsibility — this is for compact cell text.
 */
export function formatSnapshotValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserialisable]';
    }
  }
  if (typeof value === 'string') return value.length === 0 ? '—' : value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  // Fallthrough for symbols / functions / other exotic primitives:
  // they shouldn't appear in JSON-sourced snapshots but if one does
  // we don't want to render "[object Object]" in the diff cell.
  return '[unrenderable]';
}
