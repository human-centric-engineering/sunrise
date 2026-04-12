/**
 * `reflect` — critique + revise loop.
 *
 * Config:
 *   - `critiquePrompt: string` — instructions for the critic model.
 *   - `maxIterations?: number` — default 3.
 *   - `modelOverride?: string`
 *   - `temperature?: number`
 *
 * Loop:
 *   1. Take the output of the previous step as the initial draft.
 *   2. Ask the critic for concrete improvements **and** a revised draft.
 *   3. If the critic responds with something like "no further changes",
 *      stop. Otherwise, take the revised draft and loop.
 *   4. After `maxIterations` iterations, return the last draft we have.
 *
 * Output: `{ finalDraft, iterations, stopReason }`.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { reflectConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

const NO_CHANGE_MARKERS = [
  'no further changes',
  'no changes needed',
  'no improvements',
  'no more revisions',
  'looks good',
];

export async function executeReflect(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = reflectConfigSchema.parse(step.config);

  const critiquePrompt = config.critiquePrompt;
  if (typeof critiquePrompt !== 'string' || critiquePrompt.trim().length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_critique_prompt',
      'reflect step is missing a critiquePrompt'
    );
  }

  const maxIterations =
    typeof config.maxIterations === 'number' && config.maxIterations > 0 ? config.maxIterations : 3;

  // Seed the loop with the most recent step's output.
  const stepIds = Object.keys(ctx.stepOutputs);
  const lastStepId = stepIds.length > 0 ? stepIds[stepIds.length - 1] : undefined;
  let draft = lastStepId ? stringifyValue(ctx.stepOutputs[lastStepId]) : '';

  let totalTokens = 0;
  let totalCost = 0;
  let iterations = 0;
  let stopReason: 'converged' | 'max_iterations' = 'max_iterations';

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const prompt =
      `${critiquePrompt}\n\n` +
      `Current draft:\n${draft}\n\n` +
      `If the draft already meets the criteria, reply exactly with "No further changes".\n` +
      `Otherwise, produce a revised draft.`;

    const result = await runLlmCall(ctx, {
      stepId: step.id,
      prompt,
      modelOverride: config.modelOverride,
      temperature: config.temperature ?? 0.3,
    });

    totalTokens += result.tokensUsed;
    totalCost += result.costUsd;

    const lowered = result.content.toLowerCase();
    if (NO_CHANGE_MARKERS.some((m) => lowered.includes(m))) {
      stopReason = 'converged';
      break;
    }
    draft = result.content;
  }

  return {
    output: { finalDraft: draft, iterations, stopReason },
    tokensUsed: totalTokens,
    costUsd: totalCost,
  };
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

registerStepType('reflect', executeReflect);
