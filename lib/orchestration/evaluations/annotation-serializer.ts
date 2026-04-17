/**
 * Annotation Serializer (Phase 7)
 *
 * Converts between the in-memory `Map<number, Annotation>` used by the
 * evaluation runner component and the flat `Record<string, ...>` stored
 * in the evaluation session's `metadata` field.
 *
 * The metadata schema only allows `Record<string, string|number|boolean|null>`
 * with a max of 100 keys, so annotations are stored as numbered flat keys:
 *   ann_0_idx, ann_0_cat, ann_0_rat, ann_0_notes, ...
 *   ann_count (total serialized entries)
 *
 * Default annotations (no category, rating=3, empty notes) are skipped
 * to save metadata slots.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type AnnotationCategory = 'expected' | 'unexpected' | 'issue' | 'observation';

export interface Annotation {
  category: AnnotationCategory | null;
  rating: number;
  notes: string;
}

export const CATEGORIES: { value: AnnotationCategory; label: string; color: string }[] = [
  {
    value: 'expected',
    label: 'Expected',
    color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  },
  {
    value: 'unexpected',
    label: 'Unexpected',
    color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  },
  {
    value: 'issue',
    label: 'Issue',
    color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  },
  {
    value: 'observation',
    label: 'Observation',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  },
];

// ─── Serialization ──────────────────────────────────────────────────────────

export function serializeAnnotations(
  annotations: Map<number, Annotation>
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  let idx = 0;
  annotations.forEach((ann, msgIdx) => {
    if (!ann.category && ann.rating === 3 && !ann.notes) return; // skip defaults
    out[`ann_${idx}_idx`] = msgIdx;
    out[`ann_${idx}_cat`] = ann.category;
    out[`ann_${idx}_rat`] = ann.rating;
    out[`ann_${idx}_notes`] = ann.notes || null;
    idx++;
  });
  out['ann_count'] = idx;
  return out;
}

export function deserializeAnnotations(
  metadata: Record<string, unknown> | null | undefined
): Map<number, Annotation> {
  const map = new Map<number, Annotation>();
  if (!metadata) return map;
  const count = typeof metadata['ann_count'] === 'number' ? metadata['ann_count'] : 0;
  for (let i = 0; i < count; i++) {
    const msgIdx = metadata[`ann_${i}_idx`];
    const cat = metadata[`ann_${i}_cat`];
    const rat = metadata[`ann_${i}_rat`];
    const notes = metadata[`ann_${i}_notes`];
    if (typeof msgIdx === 'number') {
      map.set(msgIdx, {
        category: typeof cat === 'string' ? (cat as AnnotationCategory) : null,
        rating: typeof rat === 'number' ? rat : 3,
        notes: typeof notes === 'string' ? notes : '',
      });
    }
  }
  return map;
}
