/**
 * The shape of the synthetic personal-data corpus (§127, t-989).
 *
 * Every value in the corpus is invented. Phone numbers come from Ofcom's
 * drama ranges, emails from reserved example domains, and identifiers with a
 * check digit were generated to pass it.
 */
import type { KnownValue } from '@/lib/privacy/adapters/types';

export type CorpusDomain = 'support' | 'hr' | 'health' | 'finance' | 'b2b' | 'adversarial';

/**
 * One piece of personal data the detectors should mask. Labelled by value,
 * not by offset, so a case can be edited without recounting: every
 * whole-word occurrence of `value` in the text is labelled, unless
 * `occurrence` (1-based) picks one.
 */
export interface CorpusLabel {
  type: string;
  value: string;
  occurrence?: number;
}

export interface CorpusCase {
  id: string;
  domain: CorpusDomain;
  text: string;
  /** Everything in `text` that is personal data. Anything else detected is a false positive. */
  labels: CorpusLabel[];
  /** What the stage would pass tier B for this call. */
  knownValues?: KnownValue[];
}
