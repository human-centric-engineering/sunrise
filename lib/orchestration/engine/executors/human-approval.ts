/**
 * `human_approval` — pause for human review.
 *
 * Config:
 *   - `prompt: string` (required, validated upstream) — what to show
 *     the reviewer.
 *   - `timeoutMinutes?: number` — informational.
 *   - `notificationChannel?: string` — informational.
 *
 * Throws `PausedForApproval` so the engine catches it, yields a single
 * `approval_required` event, flips the execution row to
 * `paused_for_approval`, and returns cleanly.
 *
 * The approval payload shipped to the client is `{ prompt, previous }`
 * so the reviewer sees both the human-readable instructions and the
 * content being approved.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { humanApprovalConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError, PausedForApproval } from '@/lib/orchestration/engine/errors';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';

export function executeHumanApproval(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = humanApprovalConfigSchema.parse(step.config);
  const rawPrompt = config.prompt;
  if (typeof rawPrompt !== 'string' || rawPrompt.trim().length === 0) {
    return Promise.reject(
      new ExecutorError(step.id, 'missing_prompt', 'human_approval step is missing a prompt')
    );
  }

  // Find the most-recent step output to preview for the reviewer.
  const stepIds = Object.keys(ctx.stepOutputs);
  const lastStepId = stepIds.length > 0 ? stepIds[stepIds.length - 1] : undefined;
  const previous = lastStepId ? ctx.stepOutputs[lastStepId] : null;

  // Resolve `{{stepId.output}}`, `{{input.foo}}`, `{{vars.x}}`,
  // `{{#if vars.y}}...{{/if}}` etc. against the current context, the
  // same way llm_call does. Without this, the admin sees the raw
  // mustache template instead of the workflow's accumulated outputs.
  const prompt = interpolatePrompt(rawPrompt, ctx, lastStepId);

  return Promise.reject(
    new PausedForApproval(step.id, {
      prompt,
      previous,
      timeoutMinutes: config.timeoutMinutes,
      notificationChannel: config.notificationChannel,
      approverUserIds: config.approverUserIds,
    })
  );
}

registerStepType('human_approval', executeHumanApproval);
