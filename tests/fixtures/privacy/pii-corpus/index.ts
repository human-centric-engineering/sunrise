/**
 * The labelled synthetic corpus the local detectors are measured against
 * (§127, t-989): there are no live conversations to tune on, so this is the
 * precision and recall gate.
 *
 * - Hand-written cases per domain: support, HR, health, finance, B2B.
 * - Template-generated cases: the same shapes over many invented values.
 * - An adversarial set: text that looks like personal data and is not.
 *
 * Those three were written alongside the detectors, so they measure the cases
 * the detectors were designed for. The held-out set (`held-out.ts`) was written
 * separately, by an author who never saw the detector code, and its figures are
 * the closer estimate of how the tiers do on text nobody tuned them for. Seven
 * defects it exposed were fixed afterwards; the spec lists them. Its figures
 * are recorded after those fixes.
 *
 * `score.ts` measures a detector run against it; the recorded figures are in
 * `baseline.json`, and `tests/unit/lib/privacy/pii/corpus.test.ts` fails when
 * a change lowers any of them.
 */
import { ADVERSARIAL_CASES } from '@/tests/fixtures/privacy/pii-corpus/adversarial';
import { B2B_CASES } from '@/tests/fixtures/privacy/pii-corpus/b2b';
import { FINANCE_CASES } from '@/tests/fixtures/privacy/pii-corpus/finance';
import { HEALTH_CASES } from '@/tests/fixtures/privacy/pii-corpus/health';
import { HELD_OUT_CASES } from '@/tests/fixtures/privacy/pii-corpus/held-out';
import { HR_CASES } from '@/tests/fixtures/privacy/pii-corpus/hr';
import { SUPPORT_CASES } from '@/tests/fixtures/privacy/pii-corpus/support';
import { TEMPLATE_CASES } from '@/tests/fixtures/privacy/pii-corpus/templates';
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';

/** The cases written alongside the detectors. */
export const DEVELOPMENT_CORPUS: readonly CorpusCase[] = [
  ...SUPPORT_CASES,
  ...HR_CASES,
  ...HEALTH_CASES,
  ...FINANCE_CASES,
  ...B2B_CASES,
  ...TEMPLATE_CASES,
  ...ADVERSARIAL_CASES,
];

/** The cases written without sight of the detectors. */
export const HELD_OUT_CORPUS: readonly CorpusCase[] = HELD_OUT_CASES;
