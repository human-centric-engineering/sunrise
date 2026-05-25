/**
 * Grader: faithfulness (model-graded).
 *
 * Asks the judge: for every `[N]` marker in the answer, does citation
 * [N]'s excerpt actually support the claim it sits next to? Penalises
 * unsupported claims and hallucinated markers (e.g. `[9]` when only
 * `[1]–[3]` were supplied).
 *
 * Returns `score: null` when the answer contains no inline markers —
 * there's nothing to grade, and reporting 0 would be misleading.
 *
 * For batch runs, this is the registry-shaped variant of the same
 * rubric used by `score-response.ts`. The manual-session path keeps
 * using the bundled `scoreResponse()` for efficiency (one judge call
 * for all three rubrics).
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
    return { score: null, reasoning: 'faithfulness needs a judge model — skipped.' };
  }
  const result = await runJudgeForRubric(
    {
      name: 'faithfulness',
      description:
        "For every inline `[N]` marker in the answer, does citation [N]'s excerpt actually support the claim attached to it? Penalise unsupported claims and hallucinated markers (e.g. `[9]` when only `[1]–[3]` were supplied).",
      scale: '0..1 — score = supported marked claims / total marked claims.',
      allowNullScore: true,
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

export const faithfulnessGrader: Grader<Config> = {
  slug: 'faithfulness',
  family: 'model',
  referenceRequired: false,
  configSchema,
  defaultConfig: {},
  grade,
  description:
    'An AI judge scores how well each cited claim in the response is supported by its citation. Returns null when the answer has no inline `[N]` markers. Use for retrieval-augmented chat where citations are expected.',
};

registerGrader(faithfulnessGrader);
