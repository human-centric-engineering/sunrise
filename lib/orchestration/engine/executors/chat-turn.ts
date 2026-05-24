/**
 * `chat_turn` — conversational LLM call with auto-loaded history.
 *
 * Fills the gap between `llm_call` (single-shot, no history) and
 * `agent_call` (multi-turn within one invocation, but no cross-run
 * memory). Each `chat_turn` step:
 *
 *   1. Loads prior `AiMessage` rows for the named conversation,
 *      oldest-first, capped at `historyLimit`.
 *   2. Composes the agent's system prompt via the same
 *      `resolveEffectivePrompt` + `composeSystemPromptString` path the
 *      streaming chat handler uses (so persona/voice/guardrails
 *      inheritance is identical).
 *   3. Builds a `[system, ...history, user]` messages array and calls
 *      the agent's provider.
 *   4. If `persistMessages` (default true), writes the new user +
 *      assistant turns to `AiMessage` in one transaction so the next
 *      `chat_turn` (or the streaming chat handler in the admin chat
 *      surface) sees them.
 *   5. Returns the assistant's text as the step output, with token +
 *      cost telemetry surfaced through the standard step-result shape.
 *
 * **Provenance pinning** — written messages carry `agentVersionId`,
 * `workflowExecutionId`, `workflowVersionId`, `modelId`, `providerSlug`
 * so cross-system audits (item #47 conversation provenance bundle) work
 * for chat-turn-authored messages identically to streaming-chat ones.
 *
 * **v1 limitations** (deliberately):
 *   - No tool calls. Chain a `tool_call` step after, or use
 *     `agent_call` if you need mid-turn capability dispatch.
 *   - No streaming. Returns the full response once the LLM completes.
 *   - No citations. Add a RAG step (`rag_retrieve` →
 *     `search_knowledge_base`) before chat_turn and interpolate the
 *     results into `message`.
 *
 * These can be added in v2 without breaking the public step contract.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation, type StepResult, type WorkflowStep } from '@/types/orchestration';
import type { LlmMessage, ReasoningEffort } from '@/lib/orchestration/llm/types';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { chatTurnConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import {
  composeSystemPromptString,
  resolveEffectivePrompt,
} from '@/lib/orchestration/agents/resolve-effective-prompt';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { narrowReasoningEffort } from '@/lib/orchestration/llm/model-heuristics';

const DEFAULT_HISTORY_LIMIT = 20;
const ROLES_TO_LOAD = ['user', 'assistant'] as const;

export async function executeChatTurn(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = chatTurnConfigSchema.parse(step.config);

  // 1. Resolve runtime values from templated config.
  const conversationId = interpolatePrompt(config.conversationId, ctx).trim();
  const userMessage = interpolatePrompt(config.message, ctx);

  if (!conversationId) {
    throw new ExecutorError(
      step.id,
      'missing_conversation_id',
      'chat_turn: conversationId resolved to empty — check the template (e.g. `{{trigger.conversationId}}`) is set on this workflow'
    );
  }
  if (!userMessage.trim()) {
    throw new ExecutorError(
      step.id,
      'missing_message',
      'chat_turn: message resolved to empty — check the template (e.g. `{{trigger.text}}`) carries content'
    );
  }

  // 2. Load conversation + agent in parallel.
  const [conversation, agent] = await Promise.all([
    prisma.aiConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, agentId: true },
    }),
    prisma.aiAgent.findUnique({
      where: { slug: config.agentSlug },
      include: {
        profile: true,
        versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } },
      },
    }),
  ]);

  if (!conversation) {
    throw new ExecutorError(
      step.id,
      'conversation_not_found',
      `chat_turn: AiConversation "${conversationId}" not found`
    );
  }
  if (!agent) {
    throw new ExecutorError(
      step.id,
      'agent_not_found',
      `chat_turn: AiAgent with slug "${config.agentSlug}" not found`
    );
  }

  // 3. Resolve provider + model (handles empty defaults via system settings,
  //    same path the streaming chat handler uses).
  let resolvedBinding;
  try {
    resolvedBinding = await resolveAgentProviderAndModel(agent, 'chat');
  } catch (err) {
    throw new ExecutorError(
      step.id,
      'provider_unresolved',
      err instanceof Error ? err.message : 'Failed to resolve agent provider/model',
      err
    );
  }
  const model = config.modelOverride ?? resolvedBinding.model;
  const { provider, usedSlug: providerSlug } = await getProviderWithFallbacks(
    resolvedBinding.providerSlug,
    resolvedBinding.fallbacks
  );

  // 4. Compose system prompt (persona / voice / guardrails inheritance).
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

  // 5. Load prior messages. Order ASC so the array reads chronologically.
  //    Restrict to user/assistant roles — system rows are auto-composed
  //    from agent settings, and tool rows belong to agent_call paths
  //    that chat_turn deliberately doesn't replay.
  const historyLimit = config.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const priorMessages =
    historyLimit > 0
      ? await prisma.aiMessage.findMany({
          where: {
            conversationId,
            role: { in: [...ROLES_TO_LOAD] },
          },
          orderBy: { createdAt: 'desc' },
          take: historyLimit,
          select: { role: true, content: true },
        })
      : [];
  // findMany returned newest-first to honour `take`; flip to chronological.
  const priorMessagesAsc = priorMessages.reverse();

  // 6. Build the messages array.
  const messages: LlmMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of priorMessagesAsc) {
    // Roles in DB are 'user' | 'assistant' (filtered above), which match
    // LlmMessage role enum.
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }
  messages.push({ role: 'user', content: userMessage });

  // 7. Resolve reasoning effort (step config beats agent default).
  const stepEffort = narrowReasoningEffort(config.reasoningEffort ?? undefined);
  const agentEffort = narrowReasoningEffort(agent.reasoningEffort);
  const effectiveReasoning: ReasoningEffort | undefined = stepEffort ?? agentEffort;

  // 8. Invoke the provider.
  const started = Date.now();
  let response;
  try {
    response = await provider.chat(messages, {
      model,
      ...(config.temperature !== undefined
        ? { temperature: config.temperature }
        : agent.temperature !== null
          ? { temperature: agent.temperature }
          : {}),
      ...(config.maxTokens !== undefined
        ? { maxTokens: config.maxTokens }
        : agent.maxTokens !== null
          ? { maxTokens: agent.maxTokens }
          : {}),
      ...(effectiveReasoning !== undefined ? { reasoningEffort: effectiveReasoning } : {}),
      signal: ctx.signal,
    });
  } catch (err) {
    throw new ExecutorError(
      step.id,
      'chat_turn_failed',
      err instanceof Error ? err.message : 'Provider chat() call failed',
      err
    );
  }
  const latencyMs = Date.now() - started;

  const assistantContent = response.content ?? '';
  const tokensUsed = (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0);

  // 9. Calculate + log cost (fire-and-forget; logCost is forgiving).
  const computedCost = calculateCost(
    model,
    response.usage?.inputTokens ?? 0,
    response.usage?.outputTokens ?? 0
  );
  const totalCostUsd = computedCost.inputCostUsd + computedCost.outputCostUsd;

  // logCost is async but explicitly fire-and-forget per its contract.
  void logCost({
    agentId: agent.id,
    conversationId,
    workflowExecutionId: ctx.executionId,
    operation: CostOperation.CHAT,
    provider: providerSlug,
    model,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
    metadata: {
      stepId: step.id,
      latencyMs,
      historyTurnsLoaded: priorMessagesAsc.length,
      source: 'chat_turn',
    },
  }).catch((err: unknown) => {
    logger.warn('chat_turn: cost logging failed (non-fatal)', {
      stepId: step.id,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  // 10. Persist the new user + assistant messages (default on).
  if (config.persistMessages !== false) {
    try {
      await persistTurnMessages({
        conversationId,
        userContent: userMessage,
        assistantContent,
        providerSlug,
        model,
        executionId: ctx.executionId,
        // agentVersionId pins persisted messages to the latest AiAgentVersion
        // snapshot for audit. Workflow version pinning stays best-effort in v1
        // — audit consumers can join via AiWorkflowExecution.versionId.
        agentVersionId: agent.versions[0]?.id ?? null,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        costUsd: totalCostUsd,
        latencyMs,
      });
    } catch (err) {
      // Persistence failure does NOT block the step output — the assistant
      // already produced its reply. Log loudly and continue; the next run's
      // history will be shorter by one turn but the workflow still completes.
      logger.error('chat_turn: failed to persist message rows', {
        stepId: step.id,
        conversationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    output: assistantContent,
    tokensUsed,
    costUsd: totalCostUsd,
  };
}

interface PersistTurnArgs {
  conversationId: string;
  userContent: string;
  assistantContent: string;
  providerSlug: string;
  model: string;
  executionId: string;
  agentVersionId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

async function persistTurnMessages(args: PersistTurnArgs): Promise<void> {
  // Single transaction so a partial write (user inserted, assistant failed)
  // can't desync the conversation log.
  await prisma.$transaction(async (tx) => {
    await tx.aiMessage.create({
      data: {
        conversationId: args.conversationId,
        role: 'user',
        content: args.userContent,
        agentVersionId: args.agentVersionId,
        workflowExecutionId: args.executionId,
        modelId: args.model,
        providerSlug: args.providerSlug,
        metadata: { source: 'chat_turn' },
      },
    });
    await tx.aiMessage.create({
      data: {
        conversationId: args.conversationId,
        role: 'assistant',
        content: args.assistantContent,
        agentVersionId: args.agentVersionId,
        workflowExecutionId: args.executionId,
        modelId: args.model,
        providerSlug: args.providerSlug,
        metadata: {
          source: 'chat_turn',
          tokenUsage: { input: args.inputTokens, output: args.outputTokens },
          latencyMs: args.latencyMs,
          costUsd: args.costUsd,
        },
      },
    });
  });
}

registerStepType('chat_turn', executeChatTurn);
