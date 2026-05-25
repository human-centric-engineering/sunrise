/**
 * Grader: tool_was_called.
 *
 * Passes if the named tool/capability appears in the subject's
 * `toolCalls` trace at least `min` times. Useful for trajectory tests
 * — "did the agent actually call search_knowledge_base when answering
 * a knowledge question?"
 *
 * This is the trajectory-grading entry point for Phase 1. Phase 3 will
 * add `tool_sequence_matches` and `tool_args_match`.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';

const configSchema = z.object({
  slug: z.string().min(1),
  min: z.number().int().positive().default(1),
});

type Config = z.infer<typeof configSchema>;

// Async signature required by the Grader interface; this body is sync.
// eslint-disable-next-line @typescript-eslint/require-await
async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  const calls = input.toolCalls ?? [];
  const matched = calls.filter((c) => c.slug === input.config.slug).length;
  const pass = matched >= input.config.min;
  return {
    score: pass ? 1 : 0,
    passed: pass,
    reasoning: pass
      ? `Tool "${input.config.slug}" called ${matched} time(s) (≥ ${input.config.min}).`
      : `Tool "${input.config.slug}" called ${matched} time(s), expected ≥ ${input.config.min}.`,
  };
}

export const toolWasCalledGrader: Grader<Config> = {
  slug: 'tool_was_called',
  family: 'heuristic',
  referenceRequired: false,
  configSchema,
  defaultConfig: { slug: '', min: 1 },
  grade,
  description:
    'Passes if the named tool/capability is called at least `min` times during the run. Use to check that the agent actually invokes the tool you expect for a given question type.',
};

registerGrader(toolWasCalledGrader);
