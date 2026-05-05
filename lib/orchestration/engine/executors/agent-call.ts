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
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
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
const DEFAULT_MAX_TURNS = 3;
const MAX_AGENT_CALL_DEPTH = 3;

/**
 * Run a single-turn agent invocation: one prompt → one response (with
 * optional tool use loops).
 */
async function runSingleTurn(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>,
  agent: Awaited<ReturnType<typeof prisma.aiAgent.findFirst>>,
  initialMessages: LlmMessage[],
  toolDefinitions: LlmToolDefinition[],
  provider: LlmProvider,
  usedSlug: string,
  maxIterations: number
): Promise<StepResult> {
  let totalTokensUsed = 0;
  let totalCostUsd = 0;
  let finalContent = '';
  let currentMessages = [...initialMessages];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const turnStarted = Date.now();
    let response;
    try {
      response = await provider.chat(currentMessages, {
        model: agent!.model,
        ...(agent!.temperature !== null ? { temperature: agent!.temperature } : {}),
        ...(agent!.maxTokens !== null ? { maxTokens: agent!.maxTokens } : {}),
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
    const turnDurationMs = Date.now() - turnStarted;

    ctx.stepTelemetry?.push({
      model: agent!.model,
      provider: usedSlug,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      durationMs: turnDurationMs,
    });

    const turnTokens = response.usage.inputTokens + response.usage.outputTokens;
    const turnCost = calculateCost(
      agent!.model,
      response.usage.inputTokens,
      response.usage.outputTokens
    );

    totalTokensUsed += turnTokens;
    totalCostUsd += turnCost.totalCostUsd;

    void logCost({
      agentId: agent!.id,
      workflowExecutionId: ctx.executionId,
      model: agent!.model,
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

    if (!response.toolCalls || response.toolCalls.length === 0) {
      break;
    }

    const toolCall: LlmToolCall = response.toolCalls[0];

    const capResult = await capabilityDispatcher.dispatch(toolCall.name, toolCall.arguments, {
      userId: ctx.userId,
      agentId: agent!.id,
    });

    if (capResult.skipFollowup) {
      finalContent = JSON.stringify(capResult.data ?? capResult);
      break;
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: response.content, toolCalls: [toolCall] },
      { role: 'tool' as const, content: JSON.stringify(capResult), toolCallId: toolCall.id },
    ];
  }

  return { output: finalContent, tokensUsed: totalTokensUsed, costUsd: totalCostUsd };
}

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

  // Recursion guard — prevent infinite agent chains
  const depth = (ctx.variables.agentCallDepth as number) ?? 0;
  if (depth >= MAX_AGENT_CALL_DEPTH) {
    throw new ExecutorError(
      step.id,
      'agent_call_depth_exceeded',
      `Agent call depth ${depth} exceeds maximum of ${MAX_AGENT_CALL_DEPTH}`,
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
  const initialMessages: LlmMessage[] = [];
  if (agent.systemInstructions) {
    initialMessages.push({ role: 'system', content: agent.systemInstructions });
  }
  initialMessages.push({ role: 'user', content: interpolatedMessage });

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
  const mode = config.mode ?? 'single-turn';

  if (mode === 'single-turn') {
    return runSingleTurn(
      step,
      ctx,
      agent,
      initialMessages,
      toolDefinitions,
      provider,
      usedSlug,
      maxIterations
    );
  }

  // ── Multi-turn mode ──────────────────────────────────────────────────
  // The called agent responds, and if it appears to ask a question or
  // request more info, we feed the calling workflow's accumulated context
  // back as the next user message, up to maxTurns.

  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  let totalTokensUsed = 0;
  let totalCostUsd = 0;
  let currentMessages = [...initialMessages];
  const conversationHistory: Array<{ role: string; content: string }> = [
    { role: 'user', content: interpolatedMessage },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    // Run one turn (with tool loops)
    const turnResult = await runSingleTurn(
      step,
      ctx,
      agent,
      currentMessages,
      toolDefinitions,
      provider,
      usedSlug,
      maxIterations
    );

    totalTokensUsed += turnResult.tokensUsed;
    totalCostUsd += turnResult.costUsd;

    const assistantResponse =
      typeof turnResult.output === 'string' ? turnResult.output : JSON.stringify(turnResult.output);

    conversationHistory.push({ role: 'assistant', content: assistantResponse });

    // Check if this is the last turn or the response doesn't end with a question
    if (turn === maxTurns - 1) break;

    const looksLikeQuestion =
      assistantResponse.trim().endsWith('?') ||
      /\b(please provide|could you|can you|what is|need more|clarify)\b/i.test(assistantResponse);

    if (!looksLikeQuestion) break;

    // Generate a follow-up from the calling context. Use the workflow's
    // accumulated step outputs as additional context.
    const stepOutputSummary = Object.entries(ctx.stepOutputs)
      .map(
        ([k, v]) =>
          `[${k}]: ${typeof v === 'string' ? v.slice(0, 500) : JSON.stringify(v).slice(0, 500)}`
      )
      .join('\n');

    const followUp = `Based on the available context:\n${stepOutputSummary}\n\nPlease continue with the analysis.`;

    conversationHistory.push({ role: 'user', content: followUp });

    // Rebuild messages for next turn
    currentMessages = [
      ...initialMessages.filter((m) => m.role === 'system'),
      ...conversationHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    logger.info('agent_call: multi-turn continuation', {
      stepId: step.id,
      agentSlug,
      turn: turn + 1,
      maxTurns,
    });
  }

  const lastResponse = conversationHistory[conversationHistory.length - 1]?.content ?? '';

  return {
    output: {
      response: lastResponse,
      turns: conversationHistory.length,
      history: conversationHistory,
    },
    tokensUsed: totalTokensUsed,
    costUsd: totalCostUsd,
  };
}

registerStepType('agent_call', executeAgentCall);
