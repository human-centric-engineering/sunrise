/**
 * `guard` — safety gate that validates input against rules.
 *
 * Config:
 *   - `rules: string` — natural-language safety rules or a regex pattern.
 *   - `mode: 'llm' | 'regex'` — validation approach.
 *   - `failAction: 'block' | 'flag'` — hard stop vs. annotate and continue.
 *   - `modelOverride?: string`
 *   - `temperature?: number` — low default (0.1) for deterministic checks.
 *
 * In LLM mode the model is asked to return PASS or FAIL with a reason.
 * In regex mode the input is tested against the pattern with no LLM call.
 *
 * The step has two output handles. The executor resolves `nextStepIds`
 * to the edge whose `condition` matches `"pass"` or `"fail"`.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { guardConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt, runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

export async function executeGuard(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = guardConfigSchema.parse(step.config);

  const rules = config.rules;
  if (typeof rules !== 'string' || rules.trim().length === 0) {
    throw new ExecutorError(step.id, 'missing_rules', 'guard step is missing rules');
  }

  const mode = config.mode ?? 'llm';
  const failAction = config.failAction ?? 'block';

  let passed: boolean;
  let reason: string;
  let tokensUsed = 0;
  let costUsd = 0;

  if (mode === 'regex') {
    const input = JSON.stringify(ctx.inputData);
    try {
      const re = new RegExp(rules, 'i');
      passed = re.test(input);
    } catch {
      throw new ExecutorError(step.id, 'invalid_regex', `Invalid regex pattern: ${rules}`);
    }
    reason = passed ? 'Input matches the pattern' : 'Input does not match the pattern';
  } else {
    const interpolated = interpolatePrompt(rules, ctx);
    const prompt =
      `You are a safety gate. Evaluate the following input against these rules:\n\n` +
      `Rules: ${interpolated}\n\n` +
      `Input:\n{{input}}\n\n` +
      `Reply with exactly PASS or FAIL on the first line, then a brief reason on the second line.`;

    const result = await runLlmCall(ctx, {
      stepId: step.id,
      prompt,
      modelOverride: config.modelOverride,
      temperature: config.temperature ?? 0.1,
    });

    tokensUsed = result.tokensUsed;
    costUsd = result.costUsd;

    const firstLine = result.content.trim().split('\n')[0].trim().toUpperCase();
    passed = firstLine.startsWith('PASS');
    reason = result.content.trim().split('\n').slice(1).join('\n').trim() || result.content.trim();
  }

  const verdict = passed ? 'pass' : 'fail';

  // Resolve next step based on the verdict edge condition.
  const nextEdge = step.nextSteps.find((e) => e.condition?.toLowerCase() === verdict);

  // If failAction is 'flag', we continue to the pass edge even on failure.
  const effectiveEdge =
    !passed && failAction === 'flag'
      ? (step.nextSteps.find((e) => e.condition?.toLowerCase() === 'pass') ?? nextEdge)
      : nextEdge;

  return {
    output: { passed, reason, verdict, failAction },
    tokensUsed,
    costUsd,
    nextStepIds: effectiveEdge ? [effectiveEdge.targetStepId] : undefined,
  };
}

registerStepType('guard', executeGuard);
