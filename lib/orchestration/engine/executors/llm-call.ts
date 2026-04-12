/**
 * `llm_call` — single LLM invocation.
 *
 * Config:
 *   - `prompt: string` (required, validated upstream)
 *   - `modelOverride?: string`
 *   - `temperature?: number`
 *   - `maxTokens?: number`
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '../context';
import { ExecutorError } from '../errors';
import { runLlmCall } from '../llm-runner';
import { registerStepType } from '../executor-registry';

interface LlmCallConfig {
  prompt?: string;
  modelOverride?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function executeLlmCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = step.config as LlmCallConfig;
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
  });

  return {
    output: result.content,
    tokensUsed: result.tokensUsed,
    costUsd: result.costUsd,
  };
}

registerStepType('llm_call', executeLlmCall);
