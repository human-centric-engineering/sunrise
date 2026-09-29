/**
 * Grader: judge_agent.
 *
 * The single model-graded entry in the registry — drives an `AiAgent`
 * with `kind = 'judge'` to score the case. Config carries the slug of
 * the judge agent to use:
 *
 *     { slug: 'judge_agent', config: { agentSlug: 'eval-judge-relevance' } }
 *
 * Replaces the per-rubric graders (faithfulness/groundedness/relevance/
 * custom_rubric) the previous design shipped. Every model grader is now
 * an `AiAgent` row — admins edit the rubric in the agent form, swap
 * models without code changes, attach knowledge documents to specialist
 * judges, see judge spend on the per-agent costs page, etc.
 *
 * The built-in judges are platform agents — defined in
 * `lib/orchestration/agents/platform-agent-definitions/` and materialised
 * as `isSystem=true` rows in every org (§116). Custom judges are any
 * `kind='judge'` agent the operator creates via the agent form.
 *
 * The prompt assembly + JSON parsing lives in
 * `lib/orchestration/evaluations/judge-driver.ts` so the `judge_call`
 * workflow step type (Phase 3) shares the exact same wire shape and
 * rubric contract — admins edit one rubric, both surfaces honour it.
 */

import { z } from 'zod';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';
import { driveJudgeAgent } from '@/lib/orchestration/evaluations/judge-driver';

const configSchema = z.object({
  /** Slug of the judge agent (an AiAgent with kind='judge'). */
  agentSlug: z.string().min(1),
  /**
   * Subject brand-voice text. The worker interpolates this from the
   * subject agent's `brandVoiceInstructions` at run time when the
   * judge is `eval-judge-brand-voice` — the picker UI never sets it
   * directly. Other judges ignore it.
   */
  subjectBrandVoice: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  if (!input.judge) {
    return { score: null, reasoning: 'judge_agent: no judge user context — skipped' };
  }

  const result = await driveJudgeAgent({
    agentSlug: input.config.agentSlug,
    userId: input.judge.userId,
    question: input.userInput,
    answer: input.modelOutput,
    ...(input.expectedOutput ? { expectedOutput: input.expectedOutput } : {}),
    citations: input.citations ?? [],
    toolCalls: input.toolCalls ?? [],
    ...(input.config.subjectBrandVoice
      ? { subjectBrandVoice: input.config.subjectBrandVoice }
      : {}),
    ...(input.judge.evaluationRunId
      ? {
          costLogMetadata: {
            evaluationRunId: input.judge.evaluationRunId,
            role: 'judge',
            judgeAgentSlug: input.config.agentSlug,
          },
        }
      : {}),
  });

  const out: GraderResult = {
    score: result.score,
    reasoning: result.reasoning,
    costUsd: result.costUsd,
    tokenUsage: result.tokenUsage,
  };
  if (result.evaluationSteps && result.evaluationSteps.length > 0) {
    out.evaluationSteps = result.evaluationSteps;
  }
  return out;
}

export const judgeAgentGrader: Grader<Config> = {
  slug: 'judge_agent',
  family: 'model',
  // The judge itself decides whether it needs `expectedOutput` (e.g.
  // the Correctness judge returns null when it's missing). Run-level
  // preflight can't know per-judge requirements without an extra
  // round-trip, so we let the judge handle the null case itself.
  referenceRequired: false,
  configSchema,
  defaultConfig: { agentSlug: '' },
  grade,
  description:
    "Drives an AiAgent with kind='judge' to score the case. Pick from the 6 built-in judges or create your own. The agent's systemInstructions IS the rubric — admins edit them in the agent form.",
};

registerGrader(judgeAgentGrader);
