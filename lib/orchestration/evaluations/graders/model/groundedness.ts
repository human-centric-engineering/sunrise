/**
 * Grader: groundedness (model-graded).
 *
 * Beyond inline `[N]` markers, are the substantive claims in the
 * answer supported by *any* of the cited excerpts (or clearly common
 * knowledge)? Penalises free-floating assertions that aren't traceable
 * to evidence. Returns a score even when there are no citations.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';
import { runJudgeForRubric } from '@/lib/orchestration/evaluations/graders/model/judge-helper';

const configSchema = z.object({});
type Config = z.infer<typeof configSchema>;

async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  if (!input.judge) {
    return { score: null, reasoning: 'groundedness needs a judge model — skipped.' };
  }
  const result = await runJudgeForRubric(
    {
      name: 'groundedness',
      description:
        'Are the substantive claims in the answer supported by any of the cited excerpts, or clearly common knowledge? Penalise free-floating assertions that are not traceable to evidence.',
      scale: '0..1 — 0 = mostly unsupported, 0.5 = mixed, 1 = every claim is grounded.',
    },
    {
      userInput: input.userInput,
      modelOutput: input.modelOutput,
      citations: input.citations,
      judge: input.judge,
      signal: input.signal,
    }
  );
  return {
    score: result.score,
    reasoning: result.reasoning,
    tokenUsage: result.tokenUsage,
    costUsd: result.costUsd,
  };
}

export const groundednessGrader: Grader<Config> = {
  slug: 'groundedness',
  family: 'model',
  referenceRequired: false,
  configSchema,
  defaultConfig: {},
  grade,
  description:
    "An AI judge scores how well every claim in the response is supported by the cited sources (or common knowledge). Penalises free-floating assertions. Use as a broader 'hallucination' signal than faithfulness.",
};

registerGrader(groundednessGrader);
