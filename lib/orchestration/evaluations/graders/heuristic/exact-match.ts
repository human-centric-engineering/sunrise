/**
 * Grader: exact_match.
 *
 * Passes (`score: 1`) if the subject's output equals the case's
 * `expectedOutput` byte-for-byte. Whitespace and case differences fail
 * unless explicitly trimmed/lowercased by config. Cheap, deterministic,
 * runs on every case — use for slot-filling, structured-extraction, or
 * any test where the expected answer is exact.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const configSchema = z.object({
  trim: z.boolean().default(true),
  caseInsensitive: z.boolean().default(false),
});

type Config = z.infer<typeof configSchema>;

// Async signature required by the Grader interface; this body is sync.
// eslint-disable-next-line @typescript-eslint/require-await
async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  if (input.expectedOutput === undefined) {
    // referenceRequired enforced at run-create time, but be defensive.
    return { score: null, reasoning: 'No expected output on case — exact_match skipped.' };
  }

  const transform = (s: string): string => {
    let out = s;
    if (input.config.trim) out = out.trim();
    if (input.config.caseInsensitive) out = out.toLowerCase();
    return out;
  };

  const actual = transform(input.modelOutput);
  const expected = transform(input.expectedOutput);
  const match = actual === expected;
  return {
    score: match ? 1 : 0,
    passed: match,
    reasoning: match ? 'Exact match.' : 'Differed from expected output.',
  };
}

export const exactMatchGrader: Grader<Config> = {
  slug: 'exact_match',
  family: 'heuristic',
  referenceRequired: true,
  configSchema,
  defaultConfig: { trim: true, caseInsensitive: false },
  grade,
  description:
    "Passes if the output equals the expected output exactly. Whitespace and case differences fail unless 'trim' or 'caseInsensitive' are enabled. Use for slot-filling and structured-extraction tests.",
};

registerGrader(exactMatchGrader);
