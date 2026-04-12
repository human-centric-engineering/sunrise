/**
 * `tool_call` — invoke a registered capability.
 *
 * Config:
 *   - `capabilitySlug: string` (required, validated upstream)
 *   - `args?: Record<string, unknown>` — passed through to the dispatcher.
 *     When omitted, `ctx.inputData` is forwarded instead.
 *
 * Workflow executions aren't bound to a specific `AiAgent`, so we pass
 * a sentinel `agentId` of the form `workflow:${workflowId}` to the
 * dispatcher. This keeps rate limits scoped per-workflow and prevents
 * accidental collision with a real agent's bucket. The capability
 * registry uses opt-out semantics, so a missing pivot row just means
 * "use the capability's defaults", which is what workflows want.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { toolCallConfigSchema } from '@/lib/validations/orchestration';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

export async function executeToolCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = toolCallConfigSchema.parse(step.config);
  const slug = config.capabilitySlug;
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_capability_slug',
      'tool_call step is missing capabilitySlug'
    );
  }

  const rawArgs: Record<string, unknown> = config.args ?? ctx.inputData;

  const result = await capabilityDispatcher.dispatch(slug, rawArgs, {
    userId: ctx.userId,
    agentId: `workflow:${ctx.workflowId}`,
  });

  if (!result.success) {
    throw new ExecutorError(
      step.id,
      result.error?.code ?? 'capability_failed',
      result.error?.message ?? 'Capability dispatch failed'
    );
  }

  return {
    output: result.data ?? null,
    tokensUsed: 0,
    costUsd: 0,
  };
}

registerStepType('tool_call', executeToolCall);
