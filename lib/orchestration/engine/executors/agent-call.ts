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
import type { AgentCallTurn, StepResult, WorkflowStep } from '@/types/orchestration';
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
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  SPAN_AGENT_CALL_TURN,
  SUNRISE_AGENT_ID,
  SUNRISE_AGENT_SLUG,
  SUNRISE_COST_USD,
  SUNRISE_EXECUTION_ID,
  SUNRISE_STEP_ID,
  SUNRISE_TOOL_ITERATION,
  setSpanAttributes,
  withSpan,
} from '@/lib/orchestration/tracing';

const DEFAULT_MAX_TOOL_ITERATIONS = 5;
const DEFAULT_MAX_TURNS = 3;
const MAX_AGENT_CALL_DEPTH = 3;

/**
 * Optional resume + recording params for `runSingleTurn`. Single-turn mode
 * passes them through (so a crash mid-step resumes at the next iteration);
 * multi-turn mode passes nothing — its outer-loop replay can't reuse
 * inner-iteration entries cleanly, so it falls back to a fresh start with
 * the dispatch cache providing tool-level dedup.
 */
interface RunSingleTurnOptions {
  /** Tool-iteration index to start at; messages for prior iterations are pre-populated below. */
  startIteration?: number;
  /** Pre-built message array. When set, replaces the in-memory `[...initialMessages]` seed. */
  startMessages?: LlmMessage[];
  /** Pre-accumulated tokens/cost from prior iterations on the resumed step. */
  startTokens?: number;
  startCost?: number;
  /**
   * Pre-set finalContent. Used when resuming a step where maxIterations was
   * already hit on the prior attempt — the loop returns immediately and
   * finalContent should reflect the last assistant response, not empty.
   */
  startContent?: string;
  /**
   * Per-iteration checkpoint hook. The executor calls this from inside the
   * span callback after each iteration's outcome is decided so a crash AFTER
   * a tool dispatch (but BEFORE the next iteration's LLM call) resumes at the
   * right point. Optional — multi-turn mode passes undefined.
   */
  recordTurn?: (turn: AgentCallTurn) => Promise<void>;
}

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
  maxIterations: number,
  options: RunSingleTurnOptions = {}
): Promise<StepResult> {
  const {
    startIteration = 0,
    startMessages,
    startTokens = 0,
    startCost = 0,
    startContent = '',
    recordTurn,
  } = options;
  let totalTokensUsed = startTokens;
  let totalCostUsd = startCost;
  let finalContent = startContent;
  let currentMessages = startMessages ? [...startMessages] : [...initialMessages];

  for (let iteration = startIteration; iteration < maxIterations; iteration++) {
    const turnOutcome = await withSpan(
      SPAN_AGENT_CALL_TURN,
      {
        [GEN_AI_OPERATION_NAME]: 'chat',
        [GEN_AI_REQUEST_MODEL]: agent!.model,
        [GEN_AI_SYSTEM]: usedSlug,
        [SUNRISE_AGENT_ID]: agent!.id,
        [SUNRISE_AGENT_SLUG]: agent!.slug,
        [SUNRISE_STEP_ID]: step.id,
        [SUNRISE_EXECUTION_ID]: ctx.executionId,
        [SUNRISE_TOOL_ITERATION]: iteration,
        ...(agent!.temperature !== null
          ? { [GEN_AI_REQUEST_TEMPERATURE]: agent!.temperature }
          : {}),
      },
      async (span) => {
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
          // Carry partial cost from earlier successful turns through the error
          // so the engine's retry/fallback accumulator can surface it on the
          // trace entry. Without this, prior turns' tokens are billed via
          // AiCostLog but invisible in the row-level totals.
          throw new ExecutorError(
            step.id,
            'agent_call_failed',
            err instanceof Error ? err.message : 'Agent LLM call failed',
            err,
            true,
            totalTokensUsed,
            totalCostUsd
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

        setSpanAttributes(span, {
          [GEN_AI_RESPONSE_MODEL]: agent!.model,
          [GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
          [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
          [GEN_AI_USAGE_TOTAL_TOKENS]: turnTokens,
          [SUNRISE_COST_USD]: turnCost.totalCostUsd,
        });

        void logCost({
          agentId: agent!.id,
          workflowExecutionId: ctx.executionId,
          model: agent!.model,
          provider: usedSlug,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          operation: CostOperation.CHAT,
          isLocal: turnCost.isLocal,
          traceId: span.traceId(),
          spanId: span.spanId(),
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
          // Final-answer turn — the assistant chose not to call a tool, so the
          // step terminates with this content. Recorded with no `toolCall` so
          // a re-drive's resume logic short-circuits via `lastPrior.toolCall === undefined`.
          if (recordTurn) {
            await recordTurn({
              kind: 'agent_call',
              index: iteration,
              assistantContent: finalContent,
              tokensUsed: turnTokens,
              costUsd: turnCost.totalCostUsd,
            });
          }
          return 'break' as const;
        }

        const toolCall: LlmToolCall = response.toolCalls[0];

        const capResult = await capabilityDispatcher.dispatch(toolCall.name, toolCall.arguments, {
          userId: ctx.userId,
          agentId: agent!.id,
        });

        if (capResult.skipFollowup) {
          finalContent = JSON.stringify(capResult.data ?? capResult);
          // Capability terminated the step (e.g. cost estimate that's the final
          // answer). Record as a no-toolCall final entry — the assistantContent
          // is the synthesized result; on re-drive this short-circuits like the
          // no-tool-calls path above. We deliberately drop the toolCall info
          // from the entry to keep the resume short-circuit simple; the trace's
          // primary observability of the tool dispatch comes from the dispatcher
          // span and the cost log, both of which already fired.
          if (recordTurn) {
            await recordTurn({
              kind: 'agent_call',
              index: iteration,
              assistantContent: finalContent,
              tokensUsed: turnTokens,
              costUsd: turnCost.totalCostUsd,
            });
          }
          return 'break' as const;
        }

        // Continuing tool-iteration turn — record assistant content + the
        // chosen tool call + its dispatched result. Replay rebuilds
        // `currentMessages` by re-emitting the assistant + tool message pair
        // for each entry; the tool dispatch itself is dedup'd by the dispatch
        // cache, so the replay is free.
        if (recordTurn) {
          await recordTurn({
            kind: 'agent_call',
            index: iteration,
            assistantContent: response.content,
            toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
            toolResult: capResult,
            tokensUsed: turnTokens,
            costUsd: turnCost.totalCostUsd,
          });
        }

        currentMessages = [
          ...currentMessages,
          { role: 'assistant' as const, content: response.content, toolCalls: [toolCall] },
          { role: 'tool' as const, content: JSON.stringify(capResult), toolCallId: toolCall.id },
        ];
        return 'continue' as const;
      }
    );
    if (turnOutcome === 'break') break;
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
    // Resume restoration for single-turn mode. Multi-turn entries (those
    // carrying `outerTurn`) belong to a different execution shape and are
    // ignored — single-turn resume only reads single-turn entries.
    const priorIterTurns: AgentCallTurn[] = (ctx.resumeTurns ?? []).flatMap((t) =>
      t.kind === 'agent_call' && t.outerTurn === undefined ? [t] : []
    );

    if (priorIterTurns.length > 0) {
      const lastPrior = priorIterTurns[priorIterTurns.length - 1];
      const resumeTokens = priorIterTurns.reduce((s, t) => s + t.tokensUsed, 0);
      const resumeCost = priorIterTurns.reduce((s, t) => s + t.costUsd, 0);

      // No-toolCall last entry → the prior attempt already produced a final
      // answer (either via the LLM emitting no tool calls or a `skipFollowup`
      // capability). Short-circuit: return the cached result without firing
      // another LLM call. Same pattern as `reflect`'s converged check.
      if (!lastPrior.toolCall) {
        logger.info('agent_call: resume short-circuit — prior attempt already finalized', {
          stepId: step.id,
          priorTurns: priorIterTurns.length,
        });
        return {
          output: lastPrior.assistantContent,
          tokensUsed: resumeTokens,
          costUsd: resumeCost,
        };
      }

      // Rebuild `currentMessages` by walking the prior entries — each replays
      // as an assistant-with-toolCall message followed by the tool result.
      // The dispatch cache makes the inner tool dispatches free to "replay"
      // (cached results return without re-firing), so the rebuilt conversation
      // matches what the next LLM call would expect.
      const restoredMessages: LlmMessage[] = [...initialMessages];
      for (const turn of priorIterTurns) {
        if (turn.toolCall) {
          restoredMessages.push({
            role: 'assistant',
            content: turn.assistantContent,
            toolCalls: [turn.toolCall],
          });
          restoredMessages.push({
            role: 'tool',
            content: JSON.stringify(turn.toolResult),
            toolCallId: turn.toolCall.id,
          });
        }
      }

      logger.info('agent_call: resuming single-turn from prior iterations', {
        stepId: step.id,
        priorIterations: priorIterTurns.length,
        maxIterations,
      });

      return runSingleTurn(
        step,
        ctx,
        agent,
        initialMessages,
        toolDefinitions,
        provider,
        usedSlug,
        maxIterations,
        {
          startIteration: priorIterTurns.length,
          startMessages: restoredMessages,
          startTokens: resumeTokens,
          startCost: resumeCost,
          // `lastPrior.assistantContent` is the most recent assistant response;
          // if maxIterations was already hit on the prior attempt, the resumed
          // loop will exit immediately and return this as the output.
          startContent: lastPrior.assistantContent,
          recordTurn: ctx.recordTurn,
        }
      );
    }

    return runSingleTurn(
      step,
      ctx,
      agent,
      initialMessages,
      toolDefinitions,
      provider,
      usedSlug,
      maxIterations,
      ctx.recordTurn ? { recordTurn: ctx.recordTurn } : {}
    );
  }

  // Multi-turn mode: no resume support in this commit. Inner tool calls are
  // dedup'd by the dispatch cache (commit 2 of PR 2), so a crashed re-drive
  // re-runs outer turns from 0 but doesn't double-fire side effects. The
  // executor deliberately does NOT pass `recordTurn` down to runSingleTurn —
  // tracking inner-iteration entries in multi-turn mode would need an outer-
  // turn boundary marker (not part of `AgentCallTurn`'s shape) to replay
  // correctly, which we defer.

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
    // Run one turn (with tool loops). On failure, propagate the
    // outer-loop's accumulated cost so far PLUS any partial cost the
    // failing turn carries on its ExecutorError. Without this wrap,
    // outer turn 1's billed cost is lost when outer turn 2 throws.
    let turnResult;
    try {
      turnResult = await runSingleTurn(
        step,
        ctx,
        agent,
        currentMessages,
        toolDefinitions,
        provider,
        usedSlug,
        maxIterations
      );
    } catch (err) {
      if (err instanceof ExecutorError) {
        throw new ExecutorError(
          err.stepId,
          err.code,
          err.message,
          err.cause,
          err.retriable,
          totalTokensUsed + err.tokensUsed,
          totalCostUsd + err.costUsd
        );
      }
      throw err;
    }

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
