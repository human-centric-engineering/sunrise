/**
 * Grader: citation_count_at_least.
 *
 * Passes if the subject's response emitted at least `min` citations.
 * Useful as a low-effort signal that a RAG agent is grounding its
 * answers in retrieval rather than free-styling.
 *
 * The `faithfulness` model grader checks whether the citations
 * actually support the claims; this grader only checks that citations
 * *exist*.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const configSchema = z.object({
  min: z.number().int().positive().default(1),
});

type Config = z.infer<typeof configSchema>;

// Async signature is required by the Grader interface (model graders
// are inherently async); heuristic graders are sync but must conform.
// eslint-disable-next-line @typescript-eslint/require-await
async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  const count = input.citations?.length ?? 0;
  const pass = count >= input.config.min;
  return {
    score: pass ? 1 : 0,
    passed: pass,
    reasoning: pass
      ? `${count} citation(s) present (≥ ${input.config.min}).`
      : `${count} citation(s) present, expected ≥ ${input.config.min}.`,
  };
}

export const citationCountAtLeastGrader: Grader<Config> = {
  slug: 'citation_count_at_least',
  family: 'heuristic',
  referenceRequired: false,
  configSchema,
  defaultConfig: { min: 1 },
  grade,
  description:
    "Passes if the response emitted at least `min` citations. Use as a low-effort 'is the agent grounding its answer in retrieval at all' signal.",
};

registerGrader(citationCountAtLeastGrader);
