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
import type { ExecutionContext } from '../context';
import { ExecutorError, PausedForApproval } from '../errors';
import { registerStepType } from '../executor-registry';

interface HumanApprovalConfig {
  prompt?: string;
  timeoutMinutes?: number;
  notificationChannel?: string;
}

export function executeHumanApproval(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = step.config as HumanApprovalConfig;
  const prompt = config.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return Promise.reject(
      new ExecutorError(step.id, 'missing_prompt', 'human_approval step is missing a prompt')
    );
  }

  // Find the most-recent step output to preview for the reviewer.
  const stepIds = Object.keys(ctx.stepOutputs);
  const lastStepId = stepIds.length > 0 ? stepIds[stepIds.length - 1] : undefined;
  const previous = lastStepId ? ctx.stepOutputs[lastStepId] : null;

  return Promise.reject(
    new PausedForApproval(step.id, {
      prompt,
      previous,
      timeoutMinutes: config.timeoutMinutes,
      notificationChannel: config.notificationChannel,
    })
  );
}

registerStepType('human_approval', executeHumanApproval);
