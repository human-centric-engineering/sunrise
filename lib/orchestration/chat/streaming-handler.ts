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
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getProviderWithFallbacks, getProvider } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost, checkBudget, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { scanForInjection } from '@/lib/orchestration/chat/input-guard';
import { scanOutput } from '@/lib/orchestration/chat/output-guard';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  getCapabilityDefinitions,
  registerBuiltInCapabilities,
} from '@/lib/orchestration/capabilities/registry';
import { buildContext, invalidateContext } from '@/lib/orchestration/chat/context-builder';
import { buildMessages } from '@/lib/orchestration/chat/message-builder';
import { queueMessageEmbedding } from '@/lib/orchestration/chat/message-embedder';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { summarizeMessages } from '@/lib/orchestration/chat/summarizer';
import {
  MAX_HISTORY_MESSAGES,
  MAX_TOOL_ITERATIONS,
  type ChatRequest,
  type ChatStream,
} from '@/lib/orchestration/chat/types';

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
        void dispatchWebhookEvent('budget_exceeded', {
          agentId: agent.id,
          agentSlug: agent.slug,
          usedUsd: budget.spent,
          limitUsd: budget.limit,
        });
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

      // Emit hook event for message creation
      emitHookEvent('message.created', {
        conversationId: conversation.id,
        messageId: userMessage.id,
        agentSlug: request.agentSlug,
        agentId: agent.id,
        userId: request.userId,
        role: 'user',
      });

      // Input guard — mode-dependent behaviour
      const scanResult = scanForInjection(request.message);
      if (scanResult.flagged) {
        log.warn('Potential prompt injection detected', {
          agentSlug: request.agentSlug,
          conversationId: conversation.id,
          patterns: scanResult.patterns,
          // Never log message content
        });

        // Agent-level override takes precedence over global setting
        let guardMode: string = agent.inputGuardMode ?? 'log_only';
        if (!agent.inputGuardMode) {
          try {
            const settings = await getOrchestrationSettings();
            guardMode = settings.inputGuardMode;
          } catch {
            // Settings unavailable — fall back to log_only
          }
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

      // Load per-user-per-agent memories for context injection
      const memoryRows = await prisma.aiUserMemory.findMany({
        where: { userId: request.userId, agentId: agent.id },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: { key: true, value: true },
      });

      // Resolve the context window for token-aware truncation.
      // Agent-level maxHistoryTokens overrides the model's context window.
      const modelInfo = getModel(agent.model);
      const contextWindowTokens = agent.maxHistoryTokens ?? modelInfo?.maxContext ?? undefined;

      let messages: LlmMessage[] = buildMessages({
        systemInstructions: agent.systemInstructions,
        contextBlock,
        history: historyRows,
        newUserMessage: request.message,
        attachments: request.attachments,
        conversationSummary,
        userMemories: memoryRows.length > 0 ? memoryRows : undefined,
        brandVoiceInstructions: agent.brandVoiceInstructions,
        contextWindowTokens,
        reserveTokens: agent.maxTokens ?? undefined,
      });

      const capabilityDefinitions = await getCapabilityDefinitions(agent.id);
      const toolDefinitions: LlmToolDefinition[] = capabilityDefinitions.map((def) => ({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      }));

      const { provider, usedSlug } = await getProviderWithFallbacks(
        agent.provider,
        agent.fallbackProviders ?? []
      );
      resolvedProviderSlug = usedSlug;

      // Extract responseFormat from agent metadata if configured
      const agentMetadata = agent.metadata as Record<string, unknown> | null;
      const responseFormat = agentMetadata?.responseFormat as
        | import('@/lib/orchestration/llm/types').LlmResponseFormat
        | undefined;

      // Remaining fallback providers for mid-stream retry
      const remainingFallbacks = [...(agent.fallbackProviders ?? [])];
      let currentProvider = provider;
      let currentProviderSlug = usedSlug;

      let iteration = 0;
      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++;

        // Emit thinking indicator before each LLM turn
        if (iteration === 1) {
          yield { type: 'status', message: 'Thinking...' };
        } else {
          yield { type: 'status', message: 'Processing tool results...' };
        }

        let assistantText = '';
        const toolCalls = new Map<number, LlmToolCall>();
        let usage: { inputTokens: number; outputTokens: number } | null = null;

        const llmOptions = {
          model: agent.model,
          ...(agent.temperature !== null ? { temperature: agent.temperature } : {}),
          ...(agent.maxTokens !== null ? { maxTokens: agent.maxTokens } : {}),
          ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
          ...(responseFormat && toolDefinitions.length === 0 ? { responseFormat } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        };

        // Stream with mid-stream retry: if the stream fails, try the
        // next fallback provider and re-emit content from scratch.
        let streamSucceeded = false;
        let streamRetries = 0;
        const MAX_STREAM_RETRIES = 2;

        while (!streamSucceeded && streamRetries <= MAX_STREAM_RETRIES) {
          try {
            const stream = currentProvider.chatStream(messages, llmOptions);

            let toolCallIndex = 0;
            for await (const chunk of stream) {
              if (chunk.type === 'text') {
                if (toolCalls.size > 0) continue;
                assistantText += chunk.content;
                yield { type: 'content', delta: chunk.content };
              } else if (chunk.type === 'tool_call') {
                toolCalls.set(toolCallIndex++, chunk.toolCall);
              } else if (chunk.type === 'done') {
                usage = chunk.usage;
              }
            }
            streamSucceeded = true;
          } catch (streamErr) {
            streamRetries++;
            getBreaker(currentProviderSlug).recordFailure();

            // If aborted, don't retry
            if (
              streamErr instanceof Error &&
              (streamErr.name === 'AbortError' || streamErr.message.includes('aborted'))
            ) {
              throw streamErr;
            }

            // Try next fallback provider
            const nextSlug = remainingFallbacks.shift();
            if (!nextSlug || streamRetries > MAX_STREAM_RETRIES) {
              log.error('Stream failed, no more fallback providers', streamErr as Error, {
                agentSlug: request.agentSlug,
                provider: currentProviderSlug,
                retries: streamRetries,
              });
              throw streamErr;
            }

            log.warn('Stream failed, retrying with fallback provider', {
              failedProvider: currentProviderSlug,
              nextProvider: nextSlug,
              error: streamErr instanceof Error ? streamErr.message : String(streamErr),
            });

            yield {
              type: 'warning',
              code: 'provider_retry',
              message: `Retrying with fallback provider...`,
            };

            // Reset accumulated content for the retry
            assistantText = '';
            toolCalls.clear();
            usage = null;

            try {
              currentProvider = await getProvider(nextSlug);
              currentProviderSlug = nextSlug;
              resolvedProviderSlug = nextSlug;
            } catch {
              log.error(
                'Failed to load fallback provider',
                new Error(`Provider ${nextSlug} not available`),
                {
                  agentSlug: request.agentSlug,
                }
              );
              throw streamErr;
            }
          }
        }

        if (assistantText.length > 0) {
          const assistantMsg = await this.persistMessage({
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
          // Queue async embedding for semantic search (non-blocking)
          queueMessageEmbedding(assistantMsg.id, assistantText);
          emitHookEvent('message.created', {
            conversationId: conversation.id,
            messageId: assistantMsg.id,
            agentSlug: request.agentSlug,
            agentId: agent.id,
            userId: request.userId,
            role: 'assistant',
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

        if (toolCalls.size === 0) {
          // Output guard — scan assistant response for topic violations
          if (assistantText.length > 0) {
            const outputScan = scanOutput(assistantText, agent.topicBoundaries ?? []);
            if (outputScan.flagged) {
              log.warn('Output guard triggered', {
                agentSlug: request.agentSlug,
                conversationId: conversation.id,
                topicMatches: outputScan.topicMatches,
                builtInMatches: outputScan.builtInMatches,
              });

              // Agent-level override takes precedence over global setting
              let outputMode: string = agent.outputGuardMode ?? 'log_only';
              if (!agent.outputGuardMode) {
                try {
                  const settings = await getOrchestrationSettings();
                  outputMode = settings.outputGuardMode;
                } catch {
                  // Settings unavailable — fall back to log_only
                }
              }

              if (outputMode === 'block') {
                yield errorEvent(
                  'output_blocked',
                  'Response blocked by content policy. Please rephrase your question.'
                );
                return;
              }
              if (outputMode === 'warn_and_continue') {
                yield {
                  type: 'warning',
                  code: 'output_flagged',
                  message: 'The response was flagged for review.',
                };
              }
            }
          }

          getBreaker(usedSlug).recordSuccess();
          yield buildDoneEvent(agent.model, usage, resolvedProviderSlug);
          return;
        }

        // Tool call path — dispatch all tool calls from this turn.
        const toolCallArray = [...toolCalls.values()];
        const dispatchContext = {
          userId: request.userId,
          agentId: agent.id,
          conversationId: conversation.id,
          ...(request.entityContext ? { entityContext: request.entityContext } : {}),
        };

        if (toolCallArray.length === 1) {
          // Single tool call — preserve original event format for
          // backward compatibility with existing SSE consumers.
          const tc = toolCallArray[0];
          yield { type: 'status', message: `Executing ${tc.name}` };

          const result = await capabilityDispatcher.dispatch(
            tc.name,
            tc.arguments,
            dispatchContext
          );

          yield { type: 'capability_result', capabilitySlug: tc.name, result };

          await this.persistMessage({
            conversationId: conversation.id,
            role: 'tool',
            content: JSON.stringify(result),
            capabilitySlug: tc.name,
            toolCallId: tc.id,
            metadata: {
              toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
              result,
            },
          });

          if (request.contextType && request.contextId) {
            invalidateContext(request.contextType, request.contextId);
          }

          if (result.skipFollowup) {
            getBreaker(usedSlug).recordSuccess();
            yield buildDoneEvent(agent.model, usage, resolvedProviderSlug);
            return;
          }

          messages = [
            ...messages,
            { role: 'assistant', content: assistantText, toolCalls: [tc] },
            { role: 'tool', content: JSON.stringify(result), toolCallId: tc.id },
          ];
        } else {
          // Multiple tool calls — dispatch in parallel for performance.
          const names = toolCallArray.map((tc) => tc.name).join(', ');
          yield { type: 'status', message: `Executing ${toolCallArray.length} tools: ${names}` };

          const settled = await Promise.allSettled(
            toolCallArray.map((tc) =>
              capabilityDispatcher.dispatch(tc.name, tc.arguments, dispatchContext)
            )
          );

          const results: Array<{ capabilitySlug: string; result: unknown }> = [];
          const toolResultMessages: LlmMessage[] = [];
          let anySkipFollowup = false;

          for (let i = 0; i < toolCallArray.length; i++) {
            const tc = toolCallArray[i];
            const outcome = settled[i];
            const result =
              outcome.status === 'fulfilled'
                ? outcome.value
                : {
                    success: false,
                    error: {
                      code: 'execution_error',
                      message:
                        outcome.reason instanceof Error
                          ? outcome.reason.message
                          : 'Capability execution failed',
                    },
                  };

            results.push({ capabilitySlug: tc.name, result });

            await this.persistMessage({
              conversationId: conversation.id,
              role: 'tool',
              content: JSON.stringify(result),
              capabilitySlug: tc.name,
              toolCallId: tc.id,
              metadata: {
                toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
                result,
              },
            });

            toolResultMessages.push({
              role: 'tool',
              content: JSON.stringify(result),
              toolCallId: tc.id,
            });

            if (result.skipFollowup) anySkipFollowup = true;
          }

          yield { type: 'capability_results', results };

          if (request.contextType && request.contextId) {
            invalidateContext(request.contextType, request.contextId);
          }

          if (anySkipFollowup) {
            getBreaker(usedSlug).recordSuccess();
            yield buildDoneEvent(agent.model, usage, resolvedProviderSlug);
            return;
          }

          // Rebuild messages with the assistant turn (carrying all tool
          // calls) followed by each tool result message.
          messages = [
            ...messages,
            { role: 'assistant', content: assistantText, toolCalls: toolCallArray },
            ...toolResultMessages,
          ];
        }
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
  usage: { inputTokens: number; outputTokens: number } | null,
  providerSlug?: string | null
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
    provider: providerSlug ?? undefined,
    model,
  };
}
