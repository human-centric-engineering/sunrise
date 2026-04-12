/**
 * `plan` — LLM-driven planner.
 *
 * Produces an ordered list of sub-goals the rest of the workflow can
 * reference via `{{plan_stepId.output}}`. In 5.2 the plan is
 * informational — the engine does not synthesise new steps from it.
 * Future work: expand the plan into runtime-synthesised child steps.
 *
 * Config:
 *   - `objective: string` — what to plan.
 *   - `maxSubSteps?: number` — default 5.
 *   - `modelOverride?: string`
 *   - `temperature?: number`
 *
 * Output: `{ plan: string[], rawResponse: string }`.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '../context';
import { ExecutorError } from '../errors';
import { runLlmCall } from '../llm-runner';
import { registerStepType } from '../executor-registry';

interface PlanConfig {
  objective?: string;
  maxSubSteps?: number;
  modelOverride?: string;
  temperature?: number;
}

export async function executePlan(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = step.config as PlanConfig;
  const objective = config.objective;
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    throw new ExecutorError(step.id, 'missing_objective', 'plan step is missing an objective');
  }

  const maxSubSteps =
    typeof config.maxSubSteps === 'number' && config.maxSubSteps > 0 ? config.maxSubSteps : 5;

  const prompt =
    `${objective}\n\n` +
    `Produce at most ${maxSubSteps} ordered sub-steps. ` +
    `Reply with one sub-step per line, numbered "1.", "2.", etc. ` +
    `Do not include any other commentary.\n\n` +
    `Input:\n{{input}}`;

  const result = await runLlmCall(ctx, {
    stepId: step.id,
    prompt,
    modelOverride: config.modelOverride,
    temperature: config.temperature ?? 0.3,
  });

  const plan = parseNumberedList(result.content).slice(0, maxSubSteps);

  return {
    output: { plan, rawResponse: result.content },
    tokensUsed: result.tokensUsed,
    costUsd: result.costUsd,
  };
}

function parseNumberedList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\d+\.\s*/, ''))
    .filter((line) => line.length > 0);
}

registerStepType('plan', executePlan);
