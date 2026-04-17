/**
 * Streaming chat handler
 *
 * Platform-agnostic runtime that wires together the LLM provider
 * abstraction, the capability dispatcher, and conversation
 * persistence. Returns an `AsyncIterable<ChatEvent>` — SSE framing
 * happens in the API route layer (Session 3.3), never here.
 *
 * Responsibilities:
 * - Resolve and budget-check the agent.
 * - Load or create an `AiConversation`, hydrate message history.
 * - Build the LLM message array (system + optional locked context +
 *   truncated history + new user turn).
 * - Stream from the provider, emitting `content` events.
 * - When the model calls a tool: pause, dispatch, emit
 *   `capability_result`, persist the result, and either short-circuit
 *   (`skipFollowup`) or loop back into the LLM for a follow-up turn.
 * - Persist every message, log one `CostOperation.CHAT` row per LLM
 *   turn, and never let an exception escape the iterator — any error
 *   is surfaced as a final `{ type: 'error' }` event.
 */

import type { AiAgent, AiConversation, AiMessage, Prisma } from '@/types/prisma';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { ChatEvent, MessageMetadata } from '@/types/orchestration';
import { CostOperation } from '@/types/orchestration';
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '@/lib/orchestration/llm/types';
import { getBreaker } from '@/lib/orchestration/llm/circuit-breaker';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost, checkBudget, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { scanForInjection } from './input-guard';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  getCapabilityDefinitions,
  registerBuiltInCapabilities,
} from '@/lib/orchestration/capabilities/registry';
import { buildContext, invalidateContext } from './context-builder';
import { buildMessages } from './message-builder';
import { summarizeMessages } from './summarizer';
import {
  MAX_HISTORY_MESSAGES,
  MAX_TOOL_ITERATIONS,
  type ChatRequest,
  type ChatStream,
} from './types';

/** Narrow error class caught by the outer try and surfaced as an error event. */
export class ChatError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

interface PersistMessageParams {
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  capabilitySlug?: string;
  toolCallId?: string;
  metadata?: MessageMetadata;
}

export class StreamingChatHandler {
  /**
   * Run a chat turn against the given agent, yielding ChatEvents.
   *
   * The outer `try/catch` guarantees a final `{ type: 'error' }` event
   * is yielded before any unexpected exception escapes. Consumers can
   * trust the iterator always terminates cleanly.
   */
  async *run(request: ChatRequest): ChatStream {
    const log = request.requestId ? logger.withContext({ requestId: request.requestId }) : logger;
    let conversationId: string | null = null;
    let resolvedProviderSlug: string | null = null;
    try {
      registerBuiltInCapabilities();

      const agent = await this.loadAgent(request.agentSlug);

      const budget = await checkBudget(agent.id);

      // Budget warning at 80%
      if (
        budget.withinBudget &&
        budget.limit !== null &&
        budget.limit > 0 &&
        budget.spent / budget.limit >= 0.8
      ) {
        const pct = ((budget.spent / budget.limit) * 100).toFixed(0);
        log.warn('Agent approaching budget limit', {
          agentId: agent.id,
          spent: budget.spent,
          limit: budget.limit,
          percent: pct,
        });
        yield {
          type: 'warning',
          code: 'budget_warning',
          message: `This agent has used ${pct}% of its $${budget.limit.toFixed(2)} monthly budget.`,
        };
      }

      if (!budget.withinBudget) {
        const limitStr = budget.limit !== null ? `$${budget.limit.toFixed(2)}` : 'its';
        yield errorEvent(
          'budget_exceeded',
          `This agent has reached its monthly budget of ${limitStr}. Contact an admin to increase the limit or switch to a local model.`
        );
        return;
      }

      const conversation = await this.loadOrCreateConversation(agent, request);
      conversationId = conversation.id;
      const history = await this.loadHistory(conversation.id);

      // Persist the user message up front so a mid-stream crash still
      // leaves an audit trail.
      const userMessage = await this.persistMessage({
        conversationId: conversation.id,
        role: 'user',
        content: request.message,
      });

      yield { type: 'start', conversationId: conversation.id, messageId: userMessage.id };

      // Input guard — mode-dependent behaviour
      const scanResult = scanForInjection(request.message);
      if (scanResult.flagged) {
        log.warn('Potential prompt injection detected', {
          agentSlug: request.agentSlug,
          conversationId: conversation.id,
          patterns: scanResult.patterns,
          // Never log message content
        });

        let guardMode: string = 'log_only';
        try {
          const settings = await getOrchestrationSettings();
          guardMode = settings.inputGuardMode;
        } catch {
          // Settings unavailable — fall back to log_only
        }

        if (guardMode === 'block') {
          yield errorEvent('input_blocked', 'Message blocked by security policy.');
          return;
        }
        if (guardMode === 'warn_and_continue') {
          yield {
            type: 'warning',
            code: 'input_flagged',
            message: 'Your message was flagged for review but processing continues.',
          };
        }
      }

      // Rolling summary — when history exceeds the window, summarize
      // the oldest messages and persist the summary for future turns.
      let conversationSummary: string | undefined;
      const historyRows = history.map((m) => ({
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId,
      }));

      if (historyRows.length > MAX_HISTORY_MESSAGES) {
        const droppedCount = historyRows.length - MAX_HISTORY_MESSAGES;
        const droppedMessages = historyRows.slice(0, droppedCount);
        const lastDroppedId = history[droppedCount - 1]?.id ?? null;

        // Reuse existing summary if it covers all dropped messages
        if (conversation.summary && conversation.summaryUpToMessageId === lastDroppedId) {
          conversationSummary = conversation.summary;
        } else {
          yield { type: 'status', message: 'Summarizing conversation history...' };
          const fallbackSlugs = Array.isArray((agent as Record<string, unknown>).fallbackProviders)
            ? ((agent as Record<string, unknown>).fallbackProviders as string[])
            : [];
          conversationSummary = await summarizeMessages(
            droppedMessages,
            agent.provider,
            fallbackSlugs
          );
          // Persist for future turns
          await prisma.aiConversation.update({
            where: { id: conversation.id },
            data: { summary: conversationSummary, summaryUpToMessageId: lastDroppedId },
          });
        }
      }

      const contextBlock =
        request.contextType && request.contextId
          ? await buildContext(request.contextType, request.contextId)
          : null;

      let messages: LlmMessage[] = buildMessages({
        systemInstructions: agent.systemInstructions,
        contextBlock,
        history: historyRows,
        newUserMessage: request.message,
        conversationSummary,
      });

      const capabilityDefinitions = await getCapabilityDefinitions(agent.id);
      const toolDefinitions: LlmToolDefinition[] = capabilityDefinitions.map((def) => ({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      }));

      const { provider, usedSlug } = await getProviderWithFallbacks(
        agent.provider,
        Array.isArray((agent as Record<string, unknown>).fallbackProviders)
          ? ((agent as Record<string, unknown>).fallbackProviders as string[])
          : []
      );
      resolvedProviderSlug = usedSlug;

      let iteration = 0;
      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++;

        let assistantText = '';
        let toolCall: LlmToolCall | null = null;
        let usage: { inputTokens: number; outputTokens: number } | null = null;

        const stream = provider.chatStream(messages, {
          model: agent.model,
          ...(agent.temperature !== null ? { temperature: agent.temperature } : {}),
          ...(agent.maxTokens !== null ? { maxTokens: agent.maxTokens } : {}),
          ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });

        for await (const chunk of stream) {
          if (chunk.type === 'text') {
            // Suppress further text once we've captured a tool call —
            // we're about to dispatch and loop, so any trailing prose
            // from the same turn gets folded into the next turn's
            // context via the appended assistant message.
            if (toolCall) continue;
            assistantText += chunk.content;
            yield { type: 'content', delta: chunk.content };
          } else if (chunk.type === 'tool_call') {
            // Capture the first tool call. Multi-tool-per-turn is a
            // later slice; for now we keep draining so the trailing
            // `done` chunk (which carries usage) still lands.
            if (!toolCall) toolCall = chunk.toolCall;
          } else if (chunk.type === 'done') {
            usage = chunk.usage;
          }
        }

        if (assistantText.length > 0) {
          await this.persistMessage({
            conversationId: conversation.id,
            role: 'assistant',
            content: assistantText,
            ...(usage
              ? {
                  metadata: {
                    tokenUsage: {
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      totalTokens: usage.inputTokens + usage.outputTokens,
                    },
                  },
                }
              : {}),
          });
        }

        if (usage) {
          void logCost({
            agentId: agent.id,
            conversationId: conversation.id,
            model: agent.model,
            provider: agent.provider,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            operation: CostOperation.CHAT,
          });
        }

        if (!toolCall) {
          getBreaker(usedSlug).recordSuccess();
          yield buildDoneEvent(agent.model, usage);
          return;
        }

        // Tool call path.
        yield { type: 'status', message: `Executing ${toolCall.name}` };

        const result = await capabilityDispatcher.dispatch(toolCall.name, toolCall.arguments, {
          userId: request.userId,
          agentId: agent.id,
          conversationId: conversation.id,
          ...(request.entityContext ? { entityContext: request.entityContext } : {}),
        });

        yield { type: 'capability_result', capabilitySlug: toolCall.name, result };

        await this.persistMessage({
          conversationId: conversation.id,
          role: 'tool',
          content: JSON.stringify(result),
          capabilitySlug: toolCall.name,
          toolCallId: toolCall.id,
          metadata: {
            toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
            result,
          },
        });

        // If the tool could have mutated the entity the conversation
        // is locked to, drop the cached context so the next turn
        // re-fetches. Phase 2c has no mutating capabilities, so this
        // is a no-op in practice — the hook is wired for future
        // slices.
        if (request.contextType && request.contextId) {
          invalidateContext(request.contextType, request.contextId);
        }

        if (result.skipFollowup) {
          getBreaker(usedSlug).recordSuccess();
          yield buildDoneEvent(agent.model, usage);
          return;
        }

        // Rebuild message array with assistant turn + tool result
        // appended, then loop back to the LLM for its follow-up.
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: assistantText,
            toolCalls: [toolCall],
          },
          {
            role: 'tool',
            content: JSON.stringify(result),
            toolCallId: toolCall.id,
          },
        ];
      }

      log.warn('Chat tool loop hit iteration cap', {
        agentSlug: request.agentSlug,
        iterations: MAX_TOOL_ITERATIONS,
      });
      yield errorEvent(
        'tool_loop_cap',
        `Exceeded maximum tool iterations (${MAX_TOOL_ITERATIONS})`
      );
    } catch (err) {
      if (err instanceof ChatError) {
        log.warn('Chat handler surfaced known error', {
          code: err.code,
          message: err.message,
          agentSlug: request.agentSlug,
          conversationId,
        });
        yield errorEvent(err.code, err.message);
        return;
      }
      if (resolvedProviderSlug) {
        getBreaker(resolvedProviderSlug).recordFailure();
      }
      log.error('Streaming chat handler crashed', err as Error, {
        agentSlug: request.agentSlug,
        userId: request.userId,
        conversationId,
      });
      // Do NOT forward raw err.message — it can leak Prisma internals,
      // provider SDK details, and internal hostnames to the client. The
      // detailed error has already been logged via logger.error above.
      yield errorEvent('internal_error', 'An unexpected error occurred');
    }
  }

  private async loadAgent(slug: string): Promise<AiAgent> {
    const agent = await prisma.aiAgent.findFirst({ where: { slug, isActive: true } });
    if (!agent) {
      throw new ChatError('agent_not_found', `Active agent '${slug}' not found`);
    }
    return agent;
  }

  private async loadOrCreateConversation(
    agent: AiAgent,
    request: ChatRequest
  ): Promise<AiConversation> {
    if (request.conversationId) {
      const existing = await prisma.aiConversation.findFirst({
        where: {
          id: request.conversationId,
          userId: request.userId,
          agentId: agent.id,
          isActive: true,
        },
      });
      if (!existing) {
        throw new ChatError('conversation_not_found', 'Conversation not found');
      }
      return existing;
    }

    const data: Prisma.AiConversationUncheckedCreateInput = {
      userId: request.userId,
      agentId: agent.id,
      title: request.message.slice(0, 80),
    };
    if (request.contextType !== undefined) data.contextType = request.contextType;
    if (request.contextId !== undefined) data.contextId = request.contextId;

    return prisma.aiConversation.create({ data });
  }

  private async loadHistory(conversationId: string): Promise<AiMessage[]> {
    return prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  private async persistMessage(params: PersistMessageParams): Promise<AiMessage> {
    const data: Prisma.AiMessageUncheckedCreateInput = {
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
    };
    if (params.capabilitySlug !== undefined) data.capabilitySlug = params.capabilitySlug;
    if (params.toolCallId !== undefined) data.toolCallId = params.toolCallId;
    if (params.metadata !== undefined) {
      // `MessageMetadata` is a structured, JSON-serializable shape; the cast
      // bridges TypeScript's interface-vs-indexed-object mismatch with Prisma's
      // `InputJsonValue` — it is not laundering unvalidated data.
      data.metadata = params.metadata as Prisma.InputJsonValue;
    }
    return prisma.aiMessage.create({ data });
  }
}

/** Convenience wrapper — most callers will use this. */
export function streamChat(request: ChatRequest): ChatStream {
  return new StreamingChatHandler().run(request);
}

function errorEvent(code: string, message: string): ChatEvent {
  return { type: 'error', code, message };
}

function buildDoneEvent(
  model: string,
  usage: { inputTokens: number; outputTokens: number } | null
): ChatEvent {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const costUsd = usage ? calculateCost(model, inputTokens, outputTokens).totalCostUsd : 0;
  return {
    type: 'done',
    tokenUsage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    costUsd,
  };
}
