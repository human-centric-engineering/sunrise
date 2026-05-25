/**
 * Grader: contains.
 *
 * Passes if the subject's output contains the expected text. Case-
 * insensitive by default. Useful when the wording varies but a key
 * phrase must be present.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const configSchema = z.object({
  caseInsensitive: z.boolean().default(true),
});

type Config = z.infer<typeof configSchema>;

// Async signature required by the Grader interface; this body is sync.
// eslint-disable-next-line @typescript-eslint/require-await
async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  if (!input.expectedOutput) {
    return { score: null, reasoning: 'No expected output on case — contains skipped.' };
  }
  const haystack = input.config.caseInsensitive
    ? input.modelOutput.toLowerCase()
    : input.modelOutput;
  const needle = input.config.caseInsensitive
    ? input.expectedOutput.toLowerCase()
    : input.expectedOutput;
  const hit = haystack.includes(needle);
  return {
    score: hit ? 1 : 0,
    passed: hit,
    reasoning: hit ? `Found "${input.expectedOutput}" in output.` : `Expected text not present.`,
  };
}

export const containsGrader: Grader<Config> = {
  slug: 'contains',
  family: 'heuristic',
  referenceRequired: true,
  configSchema,
  defaultConfig: { caseInsensitive: true },
  grade,
  description:
    'Passes if the output contains the expected text. Case-insensitive by default. Useful when phrasing varies but a key term must appear.',
};

registerGrader(containsGrader);
