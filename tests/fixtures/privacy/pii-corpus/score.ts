/**
 * Scoring a detector run against the labelled corpus.
 *
 * The question is the privacy one, "would this value have been masked?", not
 * "was it given the right type?":
 *
 * - **Recall** for a type: of the values labelled with it, the share whose
 *   every character falls inside some detected span, of any type. A value
 *   covered only in part counts as missed, because the uncovered part leaves.
 * - **Precision** for a type: of the spans detected with it, the share that
 *   overlap some labelled value, of any type. A span over nothing personal is
 *   text the model loses for no gain.
 *
 * Types matter for the placeholder the model reads, but a masked value with
 * the wrong type is a cosmetic fault and a missed one is a leak, so the gate
 * measures the leak.
 */
import type { CorpusCase, CorpusLabel } from '@/tests/fixtures/privacy/pii-corpus/types';

export interface Range {
  start: number;
  end: number;
}

export interface TypedRange extends Range {
  type: string;
}

export interface TypeScore {
  labelled: number;
  recalled: number;
  detected: number;
  precise: number;
  /** recalled / labelled, or null when nothing is labelled with the type. */
  recall: number | null;
  /** precise / detected, or null when nothing was detected with the type. */
  precision: number | null;
}

export interface CorpusMiss {
  caseId: string;
  type: string;
  value: string;
}

export interface CorpusScore {
  byType: Record<string, TypeScore>;
  /** Labelled values not fully covered. */
  misses: CorpusMiss[];
  /** Detected spans over nothing labelled. */
  falsePositives: CorpusMiss[];
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The ranges a label refers to: every whole-word occurrence of its value, or
 * the one `occurrence` names. Throws when the value is not in the text, so a
 * typo in the corpus fails loudly instead of quietly dropping a label.
 */
export function labelRanges(text: string, label: CorpusLabel, caseId: string): Range[] {
  const found: Range[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(label.value, from);
    if (i === -1) break;
    const end = i + label.value.length;
    const before = text[i - 1];
    const after = text[end];
    if (
      (before === undefined || !WORD_CHAR.test(before)) &&
      (after === undefined || !WORD_CHAR.test(after))
    ) {
      found.push({ start: i, end });
    }
    from = i + 1;
  }
  if (found.length === 0) {
    throw new Error(`corpus case ${caseId}: label "${label.value}" is not in the text`);
  }
  if (label.occurrence === undefined) return found;
  const one = found[label.occurrence - 1];
  if (!one) {
    throw new Error(
      `corpus case ${caseId}: label "${label.value}" has no occurrence ${label.occurrence}`
    );
  }
  return [one];
}

function covered(range: Range, spans: readonly Range[]): boolean {
  for (let i = range.start; i < range.end; i++) {
    if (!spans.some((s) => s.start <= i && i < s.end)) return false;
  }
  return true;
}

function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

function entry(byType: Record<string, TypeScore>, type: string): TypeScore {
  byType[type] ??= {
    labelled: 0,
    recalled: 0,
    detected: 0,
    precise: 0,
    recall: null,
    precision: null,
  };
  return byType[type];
}

/** Score `detect` over `cases`. */
export async function scoreCorpus(
  cases: readonly CorpusCase[],
  detect: (c: CorpusCase) => Promise<readonly TypedRange[]>
): Promise<CorpusScore> {
  const byType: Record<string, TypeScore> = {};
  const misses: CorpusMiss[] = [];
  const falsePositives: CorpusMiss[] = [];
  for (const c of cases) {
    const spans = await detect(c);
    const labelled = c.labels.flatMap((l) =>
      labelRanges(c.text, l, c.id).map((r) => ({ ...r, type: l.type, value: l.value }))
    );
    for (const l of labelled) {
      const score = entry(byType, l.type);
      score.labelled++;
      if (covered(l, spans)) score.recalled++;
      else misses.push({ caseId: c.id, type: l.type, value: l.value });
    }
    for (const s of spans) {
      const score = entry(byType, s.type);
      score.detected++;
      if (labelled.some((l) => overlaps(l, s))) score.precise++;
      else falsePositives.push({ caseId: c.id, type: s.type, value: c.text.slice(s.start, s.end) });
    }
  }
  for (const score of Object.values(byType)) {
    score.recall = score.labelled === 0 ? null : score.recalled / score.labelled;
    score.precision = score.detected === 0 ? null : score.precise / score.detected;
  }
  return { byType, misses, falsePositives };
}
