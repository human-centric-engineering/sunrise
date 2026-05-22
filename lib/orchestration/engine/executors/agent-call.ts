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
import type {
  AgentCallTurn,
  LlmRequestParamsSnapshot,
  StepResult,
  WorkflowStep,
} from '@/types/orchestration';
import { CostOperation } from '@/types/orchestration';
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  ReasoningEffort,
} from '@/lib/orchestration/llm/types';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { resolveMaxCostPerTurn } from '@/lib/orchestration/llm/cost-caps';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  getCapabilityDefinitions,
  registerBuiltInCapabilities,
} from '@/lib/orchestration/capabilities/registry';
import { agentCallConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import {
  composeSystemPromptString,
  resolveEffectivePrompt,
} from '@/lib/orchestration/agents/resolve-effective-prompt';
import { narrowReasoningEffort } from '@/lib/orchestration/llm/model-heuristics';
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
  /**
   * Resolved reasoning-effort to use for THIS step's LLM calls. Step
   * config (`agentCallConfigSchema.reasoningEffort`) beats the agent's
   * own `AiAgent.reasoningEffort`; the executor resolves the precedence
   * once at the entry point and passes the effective value here so the
   * inner loop doesn't have to repeat the resolution per turn.
   */
  effectiveReasoningEffort?: ReasoningEffort;
  /**
   * Effective per-turn cost cap in USD, resolved at the entry point via
   * `resolveMaxCostPerTurn({ agentDefault, settingsDefault })`. Mirrors
   * the chat streaming handler's per-turn guard so an `agent_call`
   * delegating to an agent with `maxCostPerTurnUsd` set enforces the
   * same cap. `undefined` = no cap. When the loop's accumulated cost
   * crosses the cap we abort with `agent_call_budget_exceeded_per_turn`,
   * carrying the partial token/cost usage so the trace and cost log
   * reflect what was actually spent.
   */
  turnCap?: number;
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
  model: string,
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
    effectiveReasoningEffort,
    turnCap,
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
        [GEN_AI_REQUEST_MODEL]: model,
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
            model: model,
            ...(agent!.temperature !== null ? { temperature: agent!.temperature } : {}),
            ...(agent!.maxTokens !== null ? { maxTokens: agent!.maxTokens } : {}),
            ...(effectiveReasoningEffort !== undefined
              ? { reasoningEffort: effectiveReasoningEffort }
              : {}),
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

        const requestParams: LlmRequestParamsSnapshot = {};
        if (agent!.maxTokens !== null) requestParams.maxTokens = agent!.maxTokens;
        if (agent!.temperature !== null) requestParams.temperature = agent!.temperature;
        if (effectiveReasoningEffort !== undefined) {
          requestParams.reasoningEffort = effectiveReasoningEffort;
        }
        if (toolDefinitions.length > 0) requestParams.toolCount = toolDefinitions.length;
        ctx.stepTelemetry?.push({
          model: model,
          provider: usedSlug,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          durationMs: turnDurationMs,
          ...(Object.keys(requestParams).length > 0 ? { requestParams } : {}),
        });

        const turnTokens = response.usage.inputTokens + response.usage.outputTokens;
        const turnCost = calculateCost(
          model,
          response.usage.inputTokens,
          response.usage.outputTokens
        );

        totalTokensUsed += turnTokens;
        totalCostUsd += turnCost.totalCostUsd;

        setSpanAttributes(span, {
          [GEN_AI_RESPONSE_MODEL]: model,
          [GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
          [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
          [GEN_AI_USAGE_TOTAL_TOKENS]: turnTokens,
          [SUNRISE_COST_USD]: turnCost.totalCostUsd,
        });

        void logCost({
          agentId: agent!.id,
          workflowExecutionId: ctx.executionId,
          model: model,
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

        // Per-turn cost cap (mirror of the chat streaming handler's
        // guard at `streaming-handler.ts:1386`). Once the accumulated
        // step cost crosses the agent's cap, abort with a typed
        // ExecutorError that carries the partial tokens/cost so the
        // trace + cost rollup reflect what was actually spent.
        //
        // `retriable: false` — re-running won't help: the next attempt
        // will hit the same cap with the same prompt. Surface as a hard
        // step failure; the workflow's error strategy (skip / continue
        // / failure-branch) decides downstream routing.
        if (turnCap !== undefined && totalCostUsd > turnCap) {
          if (recordTurn) {
            await recordTurn({
              kind: 'agent_call',
              phase: 'terminal',
              index: iteration,
              assistantContent: response.content,
              tokensUsed: turnTokens,
              costUsd: turnCost.totalCostUsd,
            });
          }
          logger.warn('agent_call: per-turn cost cap exceeded — aborting tool loop', {
            executionId: ctx.executionId,
            stepId: step.id,
            agentSlug: usedSlug,
            iteration,
            usedUsd: totalCostUsd,
            limitUsd: turnCap,
          });
          throw new ExecutorError(
            step.id,
            'agent_call_budget_exceeded_per_turn',
            `Agent "${usedSlug}" exceeded its per-turn cost cap ($${turnCap.toFixed(4)}) after ${iteration + 1} iteration(s): $${totalCostUsd.toFixed(4)} used`,
            undefined,
            false,
            totalTokensUsed,
            totalCostUsd
          );
        }

        if (!response.toolCalls || response.toolCalls.length === 0) {
          // Final-answer turn — the assistant chose not to call a tool, so the
          // step terminates with this content. Recorded as `phase: 'terminal'`
          // so a re-drive's resume short-circuits via the discriminator check.
          if (recordTurn) {
            await recordTurn({
              kind: 'agent_call',
              phase: 'terminal',
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
          // answer). Record as `phase: 'terminal'` — the assistantContent is
          // the synthesized result; on re-drive this short-circuits like the
          // no-tool-calls path above. We deliberately drop the toolCall info
          // from the entry to keep the resume short-circuit simple; the trace's
          // primary observability of the tool dispatch comes from the dispatcher
          // span and the cost log, both of which already fired.
          if (recordTurn) {
            await recordTurn({
              kind: 'agent_call',
              phase: 'terminal',
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
        // for each entry; resume reads the stored toolResult directly (no
        // re-dispatch), so replay doesn't refire the side effect.
        if (recordTurn) {
          await recordTurn({
            kind: 'agent_call',
            phase: 'continuing',
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

  // Load the target agent with its (optional) inheritance profile so the
  // system prompt resolves the same way as the chat handler.
  const agent = await prisma.aiAgent.findFirst({
    where: { slug: agentSlug, isActive: true },
    include: { profile: true },
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

  // Resolve reasoning-effort precedence ONCE — step config beats the
  // agent's own `reasoningEffort` column. When both are null/unset, the
  // effective value is undefined and the provider sends nothing.
  //
  // Both sources are runtime-narrowed via `narrowReasoningEffort`: the
  // step config is plain JSON on the workflow definition, and the agent
  // column is plain TEXT in Postgres. Either could carry a value outside
  // the enum if it bypassed the form / Zod (raw SQL, hand-edited
  // workflow JSON, backup bundle from a fork). The narrow drops unknown
  // strings to `undefined` so the runtime falls back to "no effort sent"
  // instead of letting a phantom enum member 400 the provider call.
  const stepEffort = narrowReasoningEffort(config.reasoningEffort);
  const agentEffort = narrowReasoningEffort(agent.reasoningEffort);
  const effectiveReasoningEffort: ReasoningEffort | undefined = stepEffort ?? agentEffort;

  // Interpolate the message template
  const interpolatedMessage = interpolatePrompt(message, ctx);

  // Build the initial message array using the same persona/voice/guardrails
  // composition the chat streaming handler performs. Profile inheritance is
  // resolved here so a single agent produces byte-identical system prompts
  // whether invoked via chat or via a workflow agent_call step.
  const resolvedPrompt = resolveEffectivePrompt(
    {
      systemInstructions: agent.systemInstructions,
      persona: agent.persona,
      brandVoiceInstructions: agent.brandVoiceInstructions,
      guardrails: agent.guardrails,
      personaMode: agent.personaMode as 'override' | 'append',
      voiceMode: agent.voiceMode as 'override' | 'append',
      guardrailsMode: agent.guardrailsMode as 'override' | 'append',
    },
    agent.profile
  );
  const systemPrompt = composeSystemPromptString(resolvedPrompt);

  const initialMessages: LlmMessage[] = [];
  if (systemPrompt) {
    initialMessages.push({ role: 'system', content: systemPrompt });
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

  // Resolve provider + model: system-seeded agents (e.g. provider-model-auditor,
  // audit-report-writer) ship with empty provider/model strings that need to
  // be filled in from `AiOrchestrationSettings` + the first reachable provider
  // before we touch the provider manager. Chat/evaluation paths already do this
  // via `resolveAgentProviderAndModel` — workflow `agent_call` steps must too,
  // otherwise the empty slug propagates into `getProviderWithFallbacks` and
  // throws `provider_unavailable` with a `""` slug.
  let resolvedBinding;
  try {
    resolvedBinding = await resolveAgentProviderAndModel(agent, 'chat');
  } catch (err) {
    throw new ExecutorError(
      step.id,
      'provider_unavailable',
      `No provider configured for agent "${agentSlug}"`,
      err
    );
  }
  const resolvedModel = resolvedBinding.model;

  // Resolve provider with fallbacks
  let provider;
  let usedSlug: string;
  try {
    const result = await getProviderWithFallbacks(
      resolvedBinding.providerSlug,
      resolvedBinding.fallbacks
    );
    provider = result.provider;
    usedSlug = result.usedSlug;
  } catch (err) {
    throw new ExecutorError(
      step.id,
      'provider_unavailable',
      `Provider "${resolvedBinding.providerSlug}" unavailable for agent "${agentSlug}"`,
      err
    );
  }

  const maxIterations = config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const mode = config.mode ?? 'single-turn';

  // Resolve the per-turn cost cap (agent > org settings > undefined).
  // Mirrors the chat streaming handler's resolution at
  // `streaming-handler.ts:421-451` so a per-turn cap set on the agent
  // protects workflow `agent_call` paths the same way it protects
  // chat. Settings lookup is best-effort: a transient DB hiccup
  // shouldn't kill the workflow when the agent itself sets a cap
  // (resolution short-circuits) and shouldn't fail-closed when it
  // doesn't (treat as "no org cap").
  let turnCap: number | undefined;
  if (agent.maxCostPerTurnUsd !== null && agent.maxCostPerTurnUsd !== undefined) {
    turnCap = resolveMaxCostPerTurn({
      agentDefault: agent.maxCostPerTurnUsd,
      settingsDefault: null,
    });
  } else {
    try {
      const settings = await getOrchestrationSettings();
      turnCap = resolveMaxCostPerTurn({
        agentDefault: null,
        settingsDefault: settings.defaultMaxCostPerTurnUsd,
      });
    } catch (err) {
      logger.warn(
        'agent_call: failed to load orchestration settings for per-turn cost cap; proceeding uncapped',
        {
          executionId: ctx.executionId,
          stepId: step.id,
          agentSlug,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      turnCap = undefined;
    }
  }

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

      // Terminal-phase last entry → the prior attempt already produced a final
      // answer (either via the LLM emitting no tool calls or a `skipFollowup`
      // capability). Short-circuit: return the cached result without firing
      // another LLM call. Same pattern as `reflect`'s converged check.
      if (lastPrior.phase === 'terminal') {
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
      // Resume reads the stored toolResult directly from the checkpoint (no
      // dispatcher re-call), so replay doesn't refire the side effect. The
      // `phase === 'continuing'` narrowing makes toolCall + toolResult
      // statically required — no `if (turn.toolCall)` workaround.
      const restoredMessages: LlmMessage[] = [...initialMessages];
      for (const turn of priorIterTurns) {
        if (turn.phase === 'continuing') {
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
        resolvedModel,
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
          effectiveReasoningEffort,
          turnCap,
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
      resolvedModel,
      maxIterations,
      {
        ...(ctx.recordTurn ? { recordTurn: ctx.recordTurn } : {}),
        effectiveReasoningEffort,
        turnCap,
      }
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
        resolvedModel,
        maxIterations,
        { effectiveReasoningEffort, turnCap }
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
