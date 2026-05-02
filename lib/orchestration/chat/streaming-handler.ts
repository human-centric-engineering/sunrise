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
import type { ChatEvent, Citation, MessageMetadata } from '@/types/orchestration';
import { CostOperation } from '@/types/orchestration';
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '@/lib/orchestration/llm/types';
import { getBreaker } from '@/lib/orchestration/llm/circuit-breaker';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getProviderWithFallbacks, getProvider } from '@/lib/orchestration/llm/provider-manager';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { calculateCost, checkBudget, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { withAgentBudgetLock } from '@/lib/orchestration/llm/budget-mutex';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { scanForInjection } from '@/lib/orchestration/chat/input-guard';
import { scanOutput } from '@/lib/orchestration/chat/output-guard';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { extractCitations } from '@/lib/orchestration/chat/citations';
import {
  getCapabilityDefinitions,
  registerBuiltInCapabilities,
} from '@/lib/orchestration/capabilities/registry';
import { buildContext, invalidateContext } from '@/lib/orchestration/chat/context-builder';
import { buildMessages } from '@/lib/orchestration/chat/message-builder';
import { getUserFacingError } from '@/lib/orchestration/chat/error-messages';
import { queueMessageEmbedding } from '@/lib/orchestration/chat/message-embedder';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { summarizeMessages } from '@/lib/orchestration/chat/summarizer';
import {
  MAX_HISTORY_MESSAGES,
  MAX_TOOL_ITERATIONS,
  type ChatRequest,
  type ChatStream,
} from '@/lib/orchestration/chat/types';

/** Maximum time (ms) a single tool dispatch can run before being timed out. */
const TOOL_DISPATCH_TIMEOUT_MS = 30_000;

/** Race a promise against a timeout. Returns the timeout error shape on expiry. */
async function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = TOOL_DISPATCH_TIMEOUT_MS,
  toolName: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

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

      // Per-agent mutex prevents TOCTOU race between concurrent budget reads.
      // See lib/orchestration/llm/budget-mutex.ts for accepted over-run tolerance.
      const budget = await withAgentBudgetLock(agent.id, () => checkBudget(agent.id));

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

      // Load cap settings once — used for conversation and message limits.
      const capSettings = await prisma.aiOrchestrationSettings.findUnique({
        where: { slug: 'global' },
        select: { maxConversationsPerUser: true, maxMessagesPerConversation: true },
      });

      const conversation = await this.loadOrCreateConversation(
        agent,
        request,
        capSettings?.maxConversationsPerUser ?? null
      );
      conversationId = conversation.id;
      const history = await this.loadHistory(conversation.id);

      // Enforce message-per-conversation cap using actual DB count
      // (loadHistory returns at most 200 rows, so history.length can't
      // detect conversations that exceed 200 messages).
      const maxMessages = capSettings?.maxMessagesPerConversation ?? null;
      if (maxMessages !== null) {
        const messageCount = await prisma.aiMessage.count({
          where: { conversationId: conversation.id },
        });
        if (messageCount >= maxMessages) {
          throw new ChatError(
            'conversation_length_cap_reached',
            `This conversation has reached the maximum length (${maxMessages} messages). Please start a new conversation.`
          );
        }
      }

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
            guardMode = settings.inputGuardMode ?? 'none';
          } catch {
            logger.warn(
              'Failed to load orchestration settings for input guard mode, falling back to log_only'
            );
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
          const fallbackSlugs = agent.fallbackProviders ?? [];
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
      const agentMetadata =
        agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata)
          ? (agent.metadata as Record<string, unknown>)
          : null;
      const responseFormat = agentMetadata?.responseFormat as
        | import('@/lib/orchestration/llm/types').LlmResponseFormat
        | undefined;

      // Remaining fallback providers for mid-stream retry
      const remainingFallbacks = [...(agent.fallbackProviders ?? [])];
      let currentProvider = provider;
      let currentProviderSlug = usedSlug;

      // Track consecutive per-tool failures to avoid burning iterations
      // on a tool that keeps crashing. After 2 failures the tool is
      // skipped and the LLM receives a "temporarily unavailable" message.
      const toolFailureCounts = new Map<string, number>();
      const TOOL_FAILURE_THRESHOLD = 2;

      // Citation accumulator. Populated by citation-producing tools
      // (currently `search_knowledge_base`); markers are monotonic
      // across the whole turn so the LLM can reference any retrieved
      // chunk via `[N]` syntax. Surfaced via the `citations` SSE event
      // and persisted on the terminal assistant message metadata.
      const citations: Citation[] = [];
      let nextCitationMarker = 1;

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

            // Signal client to discard any content deltas received so far —
            // a fallback provider retry is about to start from scratch.
            yield { type: 'content_reset', reason: 'provider_fallback' };

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

        if (toolCalls.size === 0) {
          // Output guard — scan BEFORE persisting the message. If the
          // guard blocks, the response must not be saved to the
          // conversation (the user never sees it via SSE).
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
                  outputMode = settings.outputGuardMode ?? 'none';
                } catch {
                  logger.warn(
                    'Failed to load orchestration settings for output guard mode, falling back to log_only'
                  );
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
        }

        // Persist assistant message AFTER output guard (blocked responses
        // are never saved). Tool-call turns also persist here so the
        // conversation history is complete for the next LLM iteration.
        // Citations are only attached to the terminal turn (no tool calls
        // pending) — they describe the sources the LLM cited in its final
        // text, so interim tool-call turns don't carry them.
        if (assistantText.length > 0) {
          const isTerminalTurn = toolCalls.size === 0;
          const assistantMetadata: MessageMetadata = {};
          if (usage) {
            assistantMetadata.tokenUsage = {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.inputTokens + usage.outputTokens,
            };
          }
          if (isTerminalTurn && citations.length > 0) {
            assistantMetadata.citations = citations;
          }
          const assistantMsg = await this.persistMessage({
            conversationId: conversation.id,
            role: 'assistant',
            content: assistantText,
            ...(Object.keys(assistantMetadata).length > 0 ? { metadata: assistantMetadata } : {}),
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

        if (toolCalls.size === 0) {
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

          getBreaker(usedSlug).recordSuccess();
          if (citations.length > 0) {
            yield { type: 'citations', citations };
          }
          yield buildDoneEvent(agent.model, usage, resolvedProviderSlug);
          return;
        }

        // Tool call path — log cost for this LLM turn, then re-check
        // budget before dispatching tools (which will trigger another
        // LLM turn that costs more).
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

        // Re-check budget before the next tool-loop iteration (locked to
        // prevent TOCTOU overruns when concurrent requests hit the same agent).
        const midBudget = await withAgentBudgetLock(agent.id, () => checkBudget(agent.id));
        if (!midBudget.withinBudget) {
          const limitStr = midBudget.limit !== null ? `$${midBudget.limit.toFixed(2)}` : 'its';
          yield errorEvent(
            'budget_exceeded',
            `This agent has reached its monthly budget of ${limitStr}. Contact an admin to increase the limit or switch to a local model.`
          );
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

          // Skip tool if it has failed too many times consecutively
          const failCount = toolFailureCounts.get(tc.name) ?? 0;
          if (failCount >= TOOL_FAILURE_THRESHOLD) {
            log.warn('Skipping tool after repeated failures', {
              tool: tc.name,
              failures: failCount,
            });
            const unavailableResult = {
              success: false,
              error: {
                code: 'tool_unavailable',
                message: `Tool '${tc.name}' is temporarily unavailable after ${failCount} consecutive failures`,
              },
            };
            await this.persistMessage({
              conversationId: conversation.id,
              role: 'tool',
              content: JSON.stringify(unavailableResult),
              capabilitySlug: tc.name,
              toolCallId: tc.id,
              metadata: {
                toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
                result: unavailableResult,
              },
            });
            messages = [
              ...messages,
              { role: 'assistant', content: assistantText, toolCalls: [tc] },
              { role: 'tool', content: JSON.stringify(unavailableResult), toolCallId: tc.id },
            ];
            continue;
          }

          yield { type: 'status', message: `Executing ${tc.name}` };

          let result: Awaited<ReturnType<typeof capabilityDispatcher.dispatch>>;
          try {
            result = await withToolTimeout(
              capabilityDispatcher.dispatch(tc.name, tc.arguments, dispatchContext),
              TOOL_DISPATCH_TIMEOUT_MS,
              tc.name
            );
            // Reset failure count on success
            if (result.success) {
              toolFailureCounts.delete(tc.name);
            } else {
              toolFailureCounts.set(tc.name, failCount + 1);
            }
          } catch (toolErr) {
            toolFailureCounts.set(tc.name, failCount + 1);
            result = {
              success: false,
              error: {
                code: 'execution_error',
                message: toolErr instanceof Error ? toolErr.message : 'Capability execution failed',
              },
            };
          }

          // Augment with citation markers before emitting / persisting /
          // feeding back to the LLM. Citations from earlier iterations
          // accumulate in the turn-level array.
          const extracted = extractCitations(tc.name, result, nextCitationMarker);
          citations.push(...extracted.citations);
          nextCitationMarker = extracted.nextMarker;
          const augmentedResult = extracted.augmentedResult;

          yield { type: 'capability_result', capabilitySlug: tc.name, result: augmentedResult };

          await this.persistMessage({
            conversationId: conversation.id,
            role: 'tool',
            content: JSON.stringify(augmentedResult),
            capabilitySlug: tc.name,
            toolCallId: tc.id,
            metadata: {
              toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
              result: augmentedResult,
            },
          });

          if (request.contextType && request.contextId) {
            invalidateContext(request.contextType, request.contextId);
          }

          if (result.skipFollowup) {
            getBreaker(usedSlug).recordSuccess();
            if (citations.length > 0) {
              yield { type: 'citations', citations };
            }
            yield buildDoneEvent(agent.model, usage, resolvedProviderSlug);
            return;
          }

          messages = [
            ...messages,
            { role: 'assistant', content: assistantText, toolCalls: [tc] },
            { role: 'tool', content: JSON.stringify(augmentedResult), toolCallId: tc.id },
          ];
        } else {
          // Multiple tool calls — dispatch in parallel for performance.
          // Pre-filter tools that have exceeded the failure threshold.
          const dispatchable: typeof toolCallArray = [];
          const skippedResults: Array<{
            tc: (typeof toolCallArray)[0];
            result: { success: false; error: { code: string; message: string } };
          }> = [];

          for (const tc of toolCallArray) {
            const failCount = toolFailureCounts.get(tc.name) ?? 0;
            if (failCount >= TOOL_FAILURE_THRESHOLD) {
              log.warn('Skipping tool after repeated failures (parallel)', {
                tool: tc.name,
                failures: failCount,
              });
              skippedResults.push({
                tc,
                result: {
                  success: false,
                  error: {
                    code: 'tool_unavailable',
                    message: `Tool '${tc.name}' is temporarily unavailable after ${failCount} consecutive failures`,
                  },
                },
              });
            } else {
              dispatchable.push(tc);
            }
          }

          const names = dispatchable.map((tc) => tc.name).join(', ');
          const skippedCount = skippedResults.length;
          const statusParts = [`Executing ${dispatchable.length} tools: ${names}`];
          if (skippedCount > 0) statusParts.push(`(${skippedCount} skipped)`);
          yield { type: 'status', message: statusParts.join(' ') };

          const settled = await Promise.allSettled(
            dispatchable.map((tc) =>
              withToolTimeout(
                capabilityDispatcher.dispatch(tc.name, tc.arguments, dispatchContext),
                TOOL_DISPATCH_TIMEOUT_MS,
                tc.name
              )
            )
          );

          const results: Array<{ capabilitySlug: string; result: unknown }> = [];
          const toolResultMessages: LlmMessage[] = [];
          let anySkipFollowup = false;

          // Process skipped tools first
          for (const { tc, result } of skippedResults) {
            results.push({ capabilitySlug: tc.name, result });
            await this.persistMessage({
              conversationId: conversation.id,
              role: 'tool',
              content: JSON.stringify(result),
              capabilitySlug: tc.name,
              toolCallId: tc.id,
              metadata: { toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments }, result },
            });
            toolResultMessages.push({
              role: 'tool',
              content: JSON.stringify(result),
              toolCallId: tc.id,
            });
          }

          for (let i = 0; i < dispatchable.length; i++) {
            const tc = dispatchable[i];
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

            // Track failures for backoff
            const prevFails = toolFailureCounts.get(tc.name) ?? 0;
            if (
              typeof result === 'object' &&
              result !== null &&
              'success' in result &&
              result.success
            ) {
              toolFailureCounts.delete(tc.name);
            } else {
              toolFailureCounts.set(tc.name, prevFails + 1);
            }

            // Augment with citation markers (no-op for non-citation tools).
            const extracted = extractCitations(tc.name, result, nextCitationMarker);
            citations.push(...extracted.citations);
            nextCitationMarker = extracted.nextMarker;
            const augmentedResult = extracted.augmentedResult;

            results.push({ capabilitySlug: tc.name, result: augmentedResult });

            await this.persistMessage({
              conversationId: conversation.id,
              role: 'tool',
              content: JSON.stringify(augmentedResult),
              capabilitySlug: tc.name,
              toolCallId: tc.id,
              metadata: {
                toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
                result: augmentedResult,
              },
            });

            toolResultMessages.push({
              role: 'tool',
              content: JSON.stringify(augmentedResult),
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
            if (citations.length > 0) {
              yield { type: 'citations', citations };
            }
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
      if (err instanceof ProviderError) {
        log.warn('Provider error during chat', {
          code: err.code,
          message: err.message,
          agentSlug: request.agentSlug,
          conversationId,
        });
        // Use the registry's safe message — raw ProviderError messages
        // contain internal details (env var names, provider slugs, base URLs)
        // that must not reach the browser.
        const safe = getUserFacingError(err.code);
        yield errorEvent(err.code, safe.message);
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

      // Persist an error-marker assistant message so the conversation has
      // no orphaned user message with no response. Clients can detect the
      // marker via metadata.error === true.
      if (conversationId) {
        try {
          await this.persistMessage({
            conversationId,
            role: 'assistant',
            content: '[An error occurred and the response could not be completed.]',
            metadata: {
              error: true,
              errorCode: 'internal_error',
            },
          });
        } catch (persistErr) {
          log.warn('Failed to persist error-marker assistant message', {
            conversationId,
            error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
        }
      }

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
    request: ChatRequest,
    maxConversationsPerUser: number | null
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

    // Enforce per-user conversation cap before creating a new one.
    // Note: this is a soft cap — concurrent requests may race past the count
    // check, which is acceptable for a usage limit (not a security boundary).
    if (maxConversationsPerUser !== null) {
      const count = await prisma.aiConversation.count({
        where: { userId: request.userId, agentId: agent.id, isActive: true },
      });
      if (count >= maxConversationsPerUser) {
        throw new ChatError(
          'conversation_cap_reached',
          `You have reached the maximum number of conversations (${maxConversationsPerUser}) for this agent.`
        );
      }
    }

    const data: Prisma.AiConversationUncheckedCreateInput = {
      userId: request.userId,
      agentId: agent.id,
      title: request.message.slice(0, 80),
    };
    if (request.contextType !== undefined) data.contextType = request.contextType;
    if (request.contextId !== undefined) data.contextId = request.contextId;

    const conversation = await prisma.aiConversation.create({ data });
    emitHookEvent('conversation.started', {
      conversationId: conversation.id,
      agentId: agent.id,
      agentSlug: agent.slug,
      userId: request.userId,
    });
    return conversation;
  }

  private async loadHistory(conversationId: string): Promise<AiMessage[]> {
    // Fetch the 200 most recent messages (desc) then reverse to
    // chronological order. Previous `asc + take: 200` loaded the
    // oldest 200 — wrong for conversations with >200 messages.
    // Secondary sort on `id` ensures deterministic ordering for
    // messages persisted in the same millisecond.
    const messages = await prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return messages.reverse();
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
