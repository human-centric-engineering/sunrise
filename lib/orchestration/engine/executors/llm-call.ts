/**
 * `llm_call` — single LLM invocation.
 *
 * Config:
 *   - `prompt: string` (required, validated upstream)
 *   - `modelOverride?: string`
 *   - `temperature?: number`
 *   - `maxTokens?: number`
 *   - `responseFormat?: LlmResponseFormat` — request structured JSON output
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { llmCallConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

export async function executeLlmCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = llmCallConfigSchema.parse(step.config);
  const prompt = config.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ExecutorError(step.id, 'missing_prompt', 'llm_call step is missing a prompt');
  }

  const result = await runLlmCall(ctx, {
    stepId: step.id,
    prompt,
    modelOverride: config.modelOverride,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    responseFormat: config.responseFormat,
  });

  return {
    output: result.content,
    tokensUsed: result.tokensUsed,
    costUsd: result.costUsd,
  };
}

registerStepType('llm_call', executeLlmCall);
