/**
 * Grader: custom_rubric.
 *
 * Lets the user write their own scoring rubric. The config carries:
 *   - `prompt`: 1-3 sentence description of what counts as a high / low score
 *   - `scaleMin`, `scaleMax`: integer bounds (defaults 1..5)
 *   - `passThreshold`: optional cutoff → `passed: true|false`
 *
 * Persisted verbatim on the AiEvaluationRun.metricConfigs at submit
 * time (the run's hash pin makes this immutable) so rubric edits don't
 * silently invalidate historical comparisons.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';
import { runJudgeForRubric } from '@/lib/orchestration/evaluations/graders/model/judge-helper';

const configSchema = z
  .object({
    prompt: z.string().min(8).max(2000),
    scaleMin: z.number().int().nonnegative().default(1),
    scaleMax: z.number().int().positive().default(5),
    passThreshold: z.number().optional(),
  })
  .refine((c) => c.scaleMax > c.scaleMin, { message: 'scaleMax must be > scaleMin' })
  .refine(
    (c) =>
      c.passThreshold === undefined ||
      (c.passThreshold >= c.scaleMin && c.passThreshold <= c.scaleMax),
    { message: 'passThreshold must lie within [scaleMin, scaleMax]' }
  );

type Config = z.infer<typeof configSchema>;

async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  if (!input.judge) {
    return { score: null, reasoning: 'custom_rubric needs a judge model — skipped.' };
  }
  const result = await runJudgeForRubric(
    {
      name: 'custom rubric',
      description: input.config.prompt,
      scale: `${input.config.scaleMin}..${input.config.scaleMax} — apply the rubric above to produce an integer or fractional score in this range.`,
      scaleMax: input.config.scaleMax,
    },
    {
      userInput: input.userInput,
      modelOutput: input.modelOutput,
      citations: input.citations,
      judge: input.judge,
      signal: input.signal,
    }
  );

  const result_: GraderResult = {
    score: result.score,
    reasoning: result.reasoning,
    tokenUsage: result.tokenUsage,
    costUsd: result.costUsd,
  };
  if (input.config.passThreshold !== undefined && result.score !== null) {
    result_.passed = result.score >= input.config.passThreshold;
  }
  return result_;
}

export const customRubricGrader: Grader<Config> = {
  slug: 'custom_rubric',
  family: 'model',
  referenceRequired: false,
  configSchema,
  defaultConfig: {
    prompt: 'Score the response on quality. Higher is better.',
    scaleMin: 1,
    scaleMax: 5,
  },
  grade,
  description:
    'Write your own rubric. Provide a short description of what counts as a high vs. low score, set the scale (e.g. 1–5), and optionally a pass threshold. An AI judge applies the rubric to each response. Use when none of the built-in metrics fit your test.',
};

registerGrader(customRubricGrader);
