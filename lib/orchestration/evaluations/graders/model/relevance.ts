/**
 * Grader: relevance (model-graded).
 *
 * Does the answer address what the user actually asked? 0 = off-topic,
 * 0.5 = partial/tangential, 1 = direct on-topic answer. Reference-free
 * — doesn't need an expected output or citations.
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
    return { score: null, reasoning: 'relevance needs a judge model — skipped.' };
  }
  const result = await runJudgeForRubric(
    {
      name: 'relevance',
      description:
        'Does the answer address what the user actually asked? Ignore citations and grounding — only judge whether the response is on-topic for the question.',
      scale:
        '0..1 — 0 = entirely off-topic, 0.5 = partial / tangential, 1 = direct on-topic answer.',
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

export const relevanceGrader: Grader<Config> = {
  slug: 'relevance',
  family: 'model',
  referenceRequired: false,
  configSchema,
  defaultConfig: {},
  grade,
  description:
    "An AI judge scores how directly the answer addresses the user's question. Reference-free. Use as a broad 'is the agent on-topic' signal — works without expected outputs or citations.",
};

registerGrader(relevanceGrader);
