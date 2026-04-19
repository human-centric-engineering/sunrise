/**
 * `agent_call` — invoke a configured agent within a workflow.
 *
 * Unlike `llm_call` (which fires a raw prompt), `agent_call` loads the
 * full agent configuration — system instructions, model, temperature,
 * capabilities, knowledge categories — and runs a complete chat turn
 * with tool use loop.
 *
 * This enables supervisor/handoff/debate patterns: a workflow step can
 * delegate to a specialist agent that has its own system prompt, tools,
 * and knowledge scope.
 *
 * Config:
 *   - `agentSlug: string`          (required) — slug of the agent to call
 *   - `message: string`            (required) — user message (supports {{}} interpolation)
 *   - `maxToolIterations?: number`  (optional, default 5) — cap on tool use loops
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { CostOperation } from '@/types/orchestration';
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '@/lib/orchestration/llm/types';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  getCapabilityDefinitions,
  registerBuiltInCapabilities,
} from '@/lib/orchestration/capabilities/registry';
import { agentCallConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

const DEFAULT_MAX_TOOL_ITERATIONS = 5;

export async function executeAgentCall(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = agentCallConfigSchema.parse(step.config);

  const agentSlug = config.agentSlug;
  if (typeof agentSlug !== 'string' || agentSlug.trim().length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_agent_slug',
      'agent_call step is missing agentSlug',
      undefined,
      false
    );
  }

  const message = config.message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_message',
      'agent_call step is missing message',
      undefined,
      false
    );
  }

  // Load the target agent
  const agent = await prisma.aiAgent.findFirst({
    where: { slug: agentSlug, isActive: true },
  });
  if (!agent) {
    throw new ExecutorError(
      step.id,
      'agent_not_found',
      `Active agent "${agentSlug}" not found`,
      undefined,
      false
    );
  }

  // Interpolate the message template
  const interpolatedMessage = interpolatePrompt(message, ctx);

  // Build the initial message array with agent's system instructions
  const messages: LlmMessage[] = [];
  if (agent.systemInstructions) {
    messages.push({ role: 'system', content: agent.systemInstructions });
  }
  messages.push({ role: 'user', content: interpolatedMessage });

  // Resolve agent capabilities as tool definitions
  registerBuiltInCapabilities();
  const capabilityDefinitions = await getCapabilityDefinitions(agent.id);
  const toolDefinitions: LlmToolDefinition[] = capabilityDefinitions.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  }));

  // Resolve provider with fallbacks
  let provider;
  let usedSlug: string;
  try {
    const result = await getProviderWithFallbacks(agent.provider, agent.fallbackProviders ?? []);
    provider = result.provider;
    usedSlug = result.usedSlug;
  } catch (err) {
    throw new ExecutorError(
      step.id,
      'provider_unavailable',
      `Provider "${agent.provider}" unavailable for agent "${agentSlug}"`,
      err
    );
  }

  const maxIterations = config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  let totalTokensUsed = 0;
  let totalCostUsd = 0;
  let finalContent = '';
  let currentMessages = [...messages];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response;
    try {
      response = await provider.chat(currentMessages, {
        model: agent.model,
        ...(agent.temperature !== null ? { temperature: agent.temperature } : {}),
        ...(agent.maxTokens !== null ? { maxTokens: agent.maxTokens } : {}),
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
        signal: ctx.signal,
      });
    } catch (err) {
      throw new ExecutorError(
        step.id,
        'agent_call_failed',
        err instanceof Error ? err.message : 'Agent LLM call failed',
        err
      );
    }

    const turnTokens = response.usage.inputTokens + response.usage.outputTokens;
    const turnCost = calculateCost(
      agent.model,
      response.usage.inputTokens,
      response.usage.outputTokens
    );

    totalTokensUsed += turnTokens;
    totalCostUsd += turnCost.totalCostUsd;

    // Fire-and-forget cost log
    void logCost({
      agentId: agent.id,
      workflowExecutionId: ctx.executionId,
      model: agent.model,
      provider: usedSlug,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      operation: CostOperation.CHAT,
      isLocal: turnCost.isLocal,
      metadata: { stepId: step.id, iteration },
    }).catch((err: unknown) => {
      logger.warn('agent_call: logCost rejected', {
        executionId: ctx.executionId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    finalContent = response.content;

    // If no tool calls, we're done
    if (!response.toolCalls || response.toolCalls.length === 0) {
      break;
    }

    // Process the first tool call (single-tool-per-turn, matching streaming handler)
    const toolCall: LlmToolCall = response.toolCalls[0];

    const capResult = await capabilityDispatcher.dispatch(toolCall.name, toolCall.arguments, {
      userId: ctx.userId,
      agentId: agent.id,
    });

    if (capResult.skipFollowup) {
      finalContent = JSON.stringify(capResult.data ?? capResult);
      break;
    }

    // Append assistant + tool result for the next iteration
    currentMessages = [
      ...currentMessages,
      {
        role: 'assistant' as const,
        content: response.content,
        toolCalls: [toolCall],
      },
      {
        role: 'tool' as const,
        content: JSON.stringify(capResult),
        toolCallId: toolCall.id,
      },
    ];
  }

  return {
    output: finalContent,
    tokensUsed: totalTokensUsed,
    costUsd: totalCostUsd,
  };
}

registerStepType('agent_call', executeAgentCall);
