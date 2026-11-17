/**
 * The labelled synthetic corpus core's sensitivity classifier is measured
 * against (§130, t-1036). There are no live conversations to tune on, so this
 * is the precision and recall gate.
 *
 * - `development.ts` was written alongside the phrase list, so it measures the
 *   cases the list was designed for.
 * - `held-out.ts` was written by an author who never saw the classifier or its
 *   phrase list, from the category definitions alone. Its figures are the
 *   closer estimate of how the list does on text nobody tuned it for.
 *
 * Both carry messages that must NOT flag. `score.ts` measures a run;
 * `baseline.json` records the figures, and
 * `tests/unit/lib/privacy/sensitivity/corpus.test.ts` fails when a change
 * lowers any of them.
 */
import { DEVELOPMENT_CASES } from '@/tests/fixtures/privacy/sensitivity-corpus/development';
import { HELD_OUT_CASES } from '@/tests/fixtures/privacy/sensitivity-corpus/held-out';

export const DEVELOPMENT_CORPUS = DEVELOPMENT_CASES;
export const HELD_OUT_CORPUS = HELD_OUT_CASES;
