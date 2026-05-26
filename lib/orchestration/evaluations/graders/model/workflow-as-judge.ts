/**
 * Grader: workflow_as_judge.
 *
 * Drives an entire workflow as a judge. The workflow runs with case
 * inputs mapped into its variables via `inputMapping`; the final step
 * is expected to output `{ score, reasoning, evaluationSteps? }` which
 * this grader returns as a `GraderResult`. Unlocks:
 *
 *   - Pairwise grading (a workflow runs both candidates internally and
 *     emits a winner)
 *   - Knowledge-grounded judging (the judge workflow can call
 *     `lookup_authoritative_answer` mid-judging before scoring)
 *   - Conditional rubric application (router → different rubric per
 *     question type)
 *   - A/B in production (workflow routes traffic to two variants and
 *     records the delta as the score)
 *
 * Config carries the workflow slug and a mapping from workflow variable
 * names to the case fields the worker exposes:
 *
 *     {
 *       slug: 'workflow_as_judge',
 *       config: {
 *         workflowSlug: 'critique-medical-answer',
 *         inputMapping: {
 *           question: '$.userInput',
 *           answer: '$.modelOutput',
 *           reference: '$.expectedOutput',
 *         },
 *       }
 *     }
 *
 * Cost rows the workflow generates are tagged
 * `{ evaluationRunId, role: 'judge' }` — mirrors the `judge_agent`
 * grader so the cost estimator's per-role split keeps working.
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import { parseJudgeOutput } from '@/lib/orchestration/evaluations/judge-driver';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import type { WorkflowDefinition } from '@/types/orchestration';
import { isRecord } from '@/lib/utils';

const INPUT_REFS = ['$.userInput', '$.modelOutput', '$.expectedOutput', '$.citations'] as const;
type InputRef = (typeof INPUT_REFS)[number];

const configSchema = z.object({
  /** AiWorkflow.slug — the judge workflow. Must be active + published. */
  workflowSlug: z.string().min(1),
  /**
   * Map of workflow variable name → which case field to inject. The
   * picker UI in the run-create form can default this to
   * `{ question: '$.userInput', answer: '$.modelOutput' }`.
   */
  inputMapping: z.record(z.string().min(1), z.enum(INPUT_REFS)).default({
    question: '$.userInput',
    answer: '$.modelOutput',
  }),
});

type Config = z.infer<typeof configSchema>;

function resolveRef(ref: InputRef, input: GraderInput): unknown {
  switch (ref) {
    case '$.userInput':
      return input.userInput;
    case '$.modelOutput':
      return input.modelOutput;
    case '$.expectedOutput':
      return input.expectedOutput ?? '';
    case '$.citations':
      return input.citations ?? [];
    default:
      return undefined;
  }
}

async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  if (!input.judge) {
    return { score: null, reasoning: 'workflow_as_judge: no judge user context — skipped' };
  }

  const workflowRow = await prisma.aiWorkflow.findFirst({
    where: { slug: input.config.workflowSlug },
    select: {
      id: true,
      isActive: true,
      publishedVersion: { select: { id: true, snapshot: true } },
    },
  });
  if (!workflowRow) {
    return {
      score: null,
      reasoning: `workflow_as_judge: workflow "${input.config.workflowSlug}" not found`,
    };
  }
  if (!workflowRow.isActive) {
    return {
      score: null,
      reasoning: `workflow_as_judge: workflow "${input.config.workflowSlug}" is inactive`,
    };
  }
  if (!workflowRow.publishedVersion) {
    return {
      score: null,
      reasoning: `workflow_as_judge: workflow "${input.config.workflowSlug}" has no published version`,
    };
  }

  const parsed = workflowDefinitionSchema.safeParse(workflowRow.publishedVersion.snapshot);
  if (!parsed.success) {
    logger.warn('workflow_as_judge: definition failed schema validation', {
      workflowSlug: input.config.workflowSlug,
      issues: parsed.error.issues.length,
    });
    return {
      score: null,
      reasoning: `workflow_as_judge: workflow "${input.config.workflowSlug}" has a malformed published definition`,
    };
  }
  const definition = parsed.data as WorkflowDefinition;

  // Build inputData by walking the mapping. Missing refs land as the
  // empty string; the judge workflow's own steps decide what to do.
  const inputData: Record<string, unknown> = {};
  for (const [varName, ref] of Object.entries(input.config.inputMapping)) {
    inputData[varName] = resolveRef(ref, input);
  }

  const engine = new OrchestrationEngine();
  let totalCostUsd = 0;
  let totalTokensUsed = 0;
  let lastStepOutput: unknown = undefined;
  let failure: { error: string; failedStepId?: string } | undefined;

  try {
    for await (const event of engine.execute(
      {
        id: workflowRow.id,
        definition,
        versionId: workflowRow.publishedVersion.id,
      },
      inputData,
      {
        userId: input.judge.userId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.judge.evaluationRunId
          ? {
              costLogMetadata: {
                evaluationRunId: input.judge.evaluationRunId,
                role: 'judge',
                judgeWorkflowSlug: input.config.workflowSlug,
              },
            }
          : {}),
      }
    )) {
      switch (event.type) {
        case 'workflow_completed':
          totalCostUsd = event.totalCostUsd;
          totalTokensUsed = event.totalTokensUsed;
          // Only override if the terminal event actually carries an
          // output payload — preserves the last `step_completed` output
          // when the engine emits a bare terminal (defensive against
          // workflows whose final step is non-output-producing).
          if (event.output !== undefined) {
            lastStepOutput = event.output;
          }
          break;
        case 'workflow_failed':
          failure = {
            error: event.error,
            ...(event.failedStepId ? { failedStepId: event.failedStepId } : {}),
          };
          break;
        case 'step_completed':
          lastStepOutput = event.output;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    logger.error('workflow_as_judge: engine threw', {
      workflowSlug: input.config.workflowSlug,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      score: null,
      reasoning: `workflow_as_judge: engine threw — ${err instanceof Error ? err.message : String(err)}`,
      costUsd: totalCostUsd,
      tokenUsage: { input: totalTokensUsed, output: 0 },
    };
  }

  if (failure) {
    return {
      score: null,
      reasoning: failure.failedStepId
        ? `workflow_as_judge: workflow failed at step ${failure.failedStepId}: ${failure.error}`
        : `workflow_as_judge: workflow failed: ${failure.error}`,
      costUsd: totalCostUsd,
      tokenUsage: { input: totalTokensUsed, output: 0 },
    };
  }

  // The judge workflow's last step is expected to emit a JSON-shaped
  // `{score, reasoning, evaluationSteps?}` envelope — same contract a
  // judge agent uses. Object outputs are accepted directly; string
  // outputs are run through the same lenient JSON parser as the
  // `judge_agent` grader.
  const rawForParse = ((): string => {
    if (typeof lastStepOutput === 'string') return lastStepOutput;
    if (isRecord(lastStepOutput) || Array.isArray(lastStepOutput)) {
      return JSON.stringify(lastStepOutput);
    }
    if (lastStepOutput === null || lastStepOutput === undefined) return '';
    if (typeof lastStepOutput === 'number' || typeof lastStepOutput === 'boolean') {
      return String(lastStepOutput);
    }
    // Engine never yields other primitive shapes today, but be defensive.
    return '';
  })();

  const parsedJudge = parseJudgeOutput(rawForParse);
  if (!parsedJudge) {
    return {
      score: null,
      reasoning: `workflow_as_judge: workflow output was not a {score, reasoning} envelope`,
      costUsd: totalCostUsd,
      tokenUsage: { input: totalTokensUsed, output: 0 },
    };
  }

  const out: GraderResult = {
    score: parsedJudge.score,
    reasoning: parsedJudge.reasoning,
    costUsd: totalCostUsd,
    tokenUsage: { input: totalTokensUsed, output: 0 },
  };
  if (parsedJudge.evaluationSteps && parsedJudge.evaluationSteps.length > 0) {
    out.evaluationSteps = parsedJudge.evaluationSteps;
  }
  return out;
}

export const workflowAsJudgeGrader: Grader<Config> = {
  slug: 'workflow_as_judge',
  family: 'model',
  // The judge workflow itself decides whether expectedOutput is
  // required — the inputMapping makes the dependency explicit. The
  // grader can't know without parsing the workflow, so we let the
  // workflow's own steps surface a null score when the field is missing.
  referenceRequired: false,
  configSchema,
  defaultConfig: {
    workflowSlug: '',
    inputMapping: { question: '$.userInput', answer: '$.modelOutput' },
  },
  grade,
  description:
    "Drives an AiWorkflow as a judge. The workflow runs once per case with mapped inputs; the last step must output a {score, reasoning} envelope. Compose multi-step rubrics or pairwise comparisons that a single judge agent can't.",
};

registerGrader(workflowAsJudgeGrader);
