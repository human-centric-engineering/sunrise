/**
 * Grader: regex.
 *
 * Passes if the subject's output matches the configured regular
 * expression. Use for format checks — ISO dates, currency strings,
 * UK postcodes, etc. The pattern is supplied at run-creation time on
 * the grader config; the `expectedOutput` field on the dataset case
 * is unused.
 *
 * RegExp construction is sandboxed against catastrophic backtracking
 * via a small timeout (5s) per case — handled by the worker around the
 * `grade` call, not here.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const configSchema = z.object({
  pattern: z.string().min(1),
  flags: z
    .string()
    .regex(/^[gimsuy]*$/, 'Only g, i, m, s, u, y flags are allowed')
    .default(''),
});

type Config = z.infer<typeof configSchema>;

// Async signature required by the Grader interface; this body is sync.
// eslint-disable-next-line @typescript-eslint/require-await
async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  let re: RegExp;
  try {
    re = new RegExp(input.config.pattern, input.config.flags);
  } catch (err) {
    return {
      score: null,
      reasoning: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const hit = re.test(input.modelOutput);
  return {
    score: hit ? 1 : 0,
    passed: hit,
    reasoning: hit
      ? `Matched /${input.config.pattern}/${input.config.flags}.`
      : `Did not match /${input.config.pattern}/${input.config.flags}.`,
  };
}

export const regexGrader: Grader<Config> = {
  slug: 'regex',
  family: 'heuristic',
  referenceRequired: false,
  configSchema,
  defaultConfig: { pattern: '.+', flags: '' },
  grade,
  description:
    'Passes if the output matches the regular expression. Supply the pattern and optional flags (g, i, m, s, u, y). Use for format checks — ISO dates, currency, postcodes.',
};

registerGrader(regexGrader);
