/**
 * Scoring a sensitivity classifier against the labelled corpus (§130).
 *
 * Two levels, each with recall and precision:
 *
 * - **Per group**, per case: a case is positive for a group when any category
 *   it is labelled with is in that group, and flagged when any category found
 *   is. Policy acts per group, so this is the figure that says whether the
 *   right policy would have applied.
 * - **Per category**, per case: whether that category was found where it was
 *   labelled, and nowhere else. A wrong category in the right group still
 *   costs a category's precision, because the trace shows it to an admin.
 */
import {
  CORE_SENSITIVITY_CATEGORIES,
  SENSITIVITY_GROUPS,
  type SensitivityGroup,
} from '@/lib/privacy/adapters/types';
import type { SensitivityCorpusCase } from '@/tests/fixtures/privacy/sensitivity-corpus/types';

export interface Score {
  labelled: number;
  flagged: number;
  correct: number;
  /** correct / labelled, or null when nothing is labelled. */
  recall: number | null;
  /** correct / flagged, or null when nothing was flagged. */
  precision: number | null;
}

export interface SensitivityMiss {
  caseId: string;
  /** A category, or a group. */
  label: string;
}

export interface SensitivityScore {
  byGroup: Record<SensitivityGroup, Score>;
  byCategory: Record<string, Score>;
  /** Labelled categories not found. */
  misses: SensitivityMiss[];
  /** Categories found that were not labelled. */
  falsePositives: SensitivityMiss[];
}

function groupOf(category: string): SensitivityGroup | undefined {
  return Object.prototype.hasOwnProperty.call(CORE_SENSITIVITY_CATEGORIES, category)
    ? CORE_SENSITIVITY_CATEGORIES[category as keyof typeof CORE_SENSITIVITY_CATEGORIES]
    : undefined;
}

function empty(): Score {
  return { labelled: 0, flagged: 0, correct: 0, recall: null, precision: null };
}

function tally(score: Score, labelled: boolean, flagged: boolean): void {
  if (labelled) score.labelled++;
  if (flagged) score.flagged++;
  if (labelled && flagged) score.correct++;
}

function finish(score: Score): void {
  score.recall = score.labelled === 0 ? null : score.correct / score.labelled;
  score.precision = score.flagged === 0 ? null : score.correct / score.flagged;
}

/** Run `classify` over every case and score what it found. */
export async function scoreSensitivity(
  cases: readonly SensitivityCorpusCase[],
  classify: (c: SensitivityCorpusCase) => Promise<readonly string[]>
): Promise<SensitivityScore> {
  const byGroup = Object.fromEntries(SENSITIVITY_GROUPS.map((g) => [g, empty()])) as Record<
    SensitivityGroup,
    Score
  >;
  const byCategory: Record<string, Score> = Object.fromEntries(
    Object.keys(CORE_SENSITIVITY_CATEGORIES).map((c) => [c, empty()])
  );
  const misses: SensitivityMiss[] = [];
  const falsePositives: SensitivityMiss[] = [];

  for (const c of cases) {
    const found = new Set(await classify(c));
    const labelled = new Set<string>(c.categories);
    for (const category of new Set([...labelled, ...found])) {
      const score = (byCategory[category] ??= empty());
      tally(score, labelled.has(category), found.has(category));
      if (labelled.has(category) && !found.has(category))
        misses.push({ caseId: c.id, label: category });
      if (found.has(category) && !labelled.has(category)) {
        falsePositives.push({ caseId: c.id, label: category });
      }
    }
    for (const group of SENSITIVITY_GROUPS) {
      const inLabels = [...labelled].some((x) => groupOf(x) === group);
      const inFound = [...found].some((x) => groupOf(x) === group);
      tally(byGroup[group], inLabels, inFound);
    }
  }
  for (const s of Object.values(byGroup)) finish(s);
  for (const s of Object.values(byCategory)) finish(s);
  return { byGroup, byCategory, misses, falsePositives };
}
