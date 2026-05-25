/**
 * Grader: length_between.
 *
 * Passes if the subject's output length (in characters) sits in the
 * configured range. Useful as a coarse "is the answer absurdly short
 * or overlong" regression check.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const configSchema = z
  .object({
    min: z.number().int().nonnegative().default(0),
    max: z.number().int().positive().default(10_000),
  })
  .refine((c) => c.max >= c.min, { message: 'max must be ≥ min' });

type Config = z.infer<typeof configSchema>;

// Async signature required by the Grader interface; this body is sync.
// eslint-disable-next-line @typescript-eslint/require-await
async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  const len = input.modelOutput.length;
  const pass = len >= input.config.min && len <= input.config.max;
  return {
    score: pass ? 1 : 0,
    passed: pass,
    reasoning: pass
      ? `Output length ${len} is within [${input.config.min}, ${input.config.max}].`
      : `Output length ${len} is outside [${input.config.min}, ${input.config.max}].`,
  };
}

export const lengthBetweenGrader: Grader<Config> = {
  slug: 'length_between',
  family: 'heuristic',
  referenceRequired: false,
  configSchema,
  defaultConfig: { min: 10, max: 2000 },
  grade,
  description:
    'Passes if the output length (in characters) sits between min and max. A coarse regression check for absurdly short or overlong answers.',
};

registerGrader(lengthBetweenGrader);
