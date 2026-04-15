/**
 * `evaluate` — score output quality against a rubric.
 *
 * Config:
 *   - `rubric: string` — scoring criteria prompt.
 *   - `scaleMin?: number` — lower bound (default 1).
 *   - `scaleMax?: number` — upper bound (default 5).
 *   - `threshold?: number` — optional pass/fail threshold.
 *   - `modelOverride?: string`
 *   - `temperature?: number`
 *
 * The model is asked to return a numeric score and reasoning.
 * Output: `{ score, reasoning, passed }` where `passed = score >= threshold`
 * (always true when no threshold is set).
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { evaluateConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

export async function executeEvaluate(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = evaluateConfigSchema.parse(step.config);

  const rubric = config.rubric;
  if (typeof rubric !== 'string' || rubric.trim().length === 0) {
    throw new ExecutorError(step.id, 'missing_rubric', 'evaluate step is missing a rubric');
  }

  const scaleMin = typeof config.scaleMin === 'number' ? config.scaleMin : 1;
  const scaleMax = typeof config.scaleMax === 'number' ? config.scaleMax : 5;

  const prompt =
    `You are an evaluator. Score the following input on a scale of ${scaleMin} to ${scaleMax}.\n\n` +
    `Rubric: ${rubric}\n\n` +
    `Input:\n{{input}}\n\n` +
    `Reply with the numeric score on the first line (just the number), ` +
    `then your reasoning on subsequent lines.`;

  const result = await runLlmCall(ctx, {
    stepId: step.id,
    prompt,
    modelOverride: config.modelOverride,
    temperature: config.temperature ?? 0.3,
  });

  const firstLine = result.content.trim().split('\n')[0].trim();
  const score = parseFloat(firstLine);

  if (isNaN(score)) {
    throw new ExecutorError(
      step.id,
      'invalid_score',
      `Evaluator returned non-numeric score: "${firstLine.slice(0, 64)}"`
    );
  }

  const clamped = Math.max(scaleMin, Math.min(scaleMax, score));
  const reasoning = result.content.trim().split('\n').slice(1).join('\n').trim();
  const threshold = config.threshold;
  const passed = typeof threshold === 'number' ? clamped >= threshold : true;

  return {
    output: { score: clamped, reasoning, passed, threshold: threshold ?? null },
    tokensUsed: result.tokensUsed,
    costUsd: result.costUsd,
  };
}

registerStepType('evaluate', executeEvaluate);
