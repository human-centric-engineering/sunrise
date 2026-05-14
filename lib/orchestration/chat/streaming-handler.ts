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
import type {
  ChatEvent,
  Citation,
  InputBreakdown,
  MessageMetadata,
  PendingApproval,
  ToolCallTrace,
} from '@/types/orchestration';
import { CostOperation } from '@/types/orchestration';
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '@/lib/orchestration/llm/types';
import { getBreaker } from '@/lib/orchestration/llm/circuit-breaker';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import {
  assertModelSupportsAttachments,
  getProvider,
  getProviderWithFallbacks,
  type AttachmentCapability,
} from '@/lib/orchestration/llm/provider-manager';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { calculateCost, checkBudget, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { withAgentBudgetLock } from '@/lib/orchestration/llm/budget-mutex';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { scanForInjection } from '@/lib/orchestration/chat/input-guard';
import { scanCitations, scanOutput } from '@/lib/orchestration/chat/output-guard';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { extractCitations } from '@/lib/orchestration/chat/citations';
import {
  getCapabilityDefinitions,
  registerBuiltInCapabilities,
} from '@/lib/orchestration/capabilities/registry';
import { buildContext, invalidateContext } from '@/lib/orchestration/chat/context-builder';
import { buildMessagesAndBreakdown } from '@/lib/orchestration/chat/message-builder';
import { estimateTokens } from '@/lib/orchestration/chat/token-estimator';
import { getUserFacingError } from '@/lib/orchestration/chat/error-messages';
import { queueMessageEmbedding } from '@/lib/orchestration/chat/message-embedder';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { summarizeMessages } from '@/lib/orchestration/chat/summarizer';
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  SPAN_CHAT_TURN,
  SPAN_LLM_CALL,
  SUNRISE_AGENT_ID,
  SUNRISE_AGENT_SLUG,
  SUNRISE_CONVERSATION_ID,
  SUNRISE_PROVIDER_FAILOVER_FROM,
  SUNRISE_PROVIDER_FAILOVER_TO,
  SUNRISE_TOOL_ITERATION,
  SUNRISE_USER_ID,
  recordSpanException,
  setSpanAttributes,
  setSpanStatus,
  withSpanGenerator,
  type Span,
} from '@/lib/orchestration/tracing';
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

/**
 * Build a {@link ToolCallTrace} from a dispatch outcome. Keeps the
 * per-tool admin diagnostic shape consistent across the single-tool and
 * parallel-tool branches of the loop.
 *
 * `resultPreview` is truncated to ~480 chars so the persisted metadata
 * column stays well below the Prisma row-size budget even after a many-
 * tool turn. The full result is still available on the tool-role
 * message's `metadata.result` for any caller that needs it.
 */
function buildToolCallTrace(
  slug: string,
  args: unknown,
  result: unknown,
  latencyMs: number
): ToolCallTrace {
  const success =
    typeof result === 'object' && result !== null && 'success' in result
      ? (result as { success: unknown }).success === true
      : false;
  const errorObj =
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof (result as { error: unknown }).error === 'object' &&
    (result as { error: unknown }).error !== null
      ? ((result as { error: { code?: unknown } }).error as { code?: unknown })
      : null;
  const errorCode = typeof errorObj?.code === 'string' ? errorObj.code : undefined;

  let resultPreview: string | undefined;
  try {
    const json = JSON.stringify(result);
    if (json) resultPreview = json.length > 480 ? `${json.slice(0, 477)}...` : json;
  } catch {
    // Non-serialisable result (cyclic, BigInt) — skip preview rather than throw.
  }

  return {
    slug,
    arguments: args,
    latencyMs,
    success,
    ...(errorCode ? { errorCode } : {}),
    ...(resultPreview ? { resultPreview } : {}),
  };
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

interface WriteEvaluationLogParams {
  contextType?: string;
  contextId?: string;
  /**
   * Caller's userId — used to verify the evaluation session belongs to
   * the calling user before any rows are written. Without this check a
   * malicious admin could mirror chat events into another admin's
   * evaluation session and distort their metric scores when that admin
   * later runs `/complete` or `/rescore`.
   */
  userId: string;
  eventType: 'user_input' | 'ai_response' | 'capability_call' | 'capability_result';
  content?: string;
  messageId?: string;
  capabilitySlug?: string;
  inputData?: unknown;
  outputData?: unknown;
  executionTimeMs?: number;
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
  metadata?: { citations?: Citation[] };
}

export class StreamingChatHandler {
  /**
   * Per-instance sequence cache for AiEvaluationLog writes. Set lazily on
   * first write for a given session, then incremented locally so we don't
   * re-query MAX(sequenceNumber) on every event in a turn. One handler
   * instance handles one chat turn, so leakage between sessions is not
   * possible — but we key on sessionId defensively.
   *
   * `denied` is set to `true` when the ownership check fails (the session
   * doesn't exist, or it belongs to a different user). When denied, every
   * subsequent `writeEvaluationLog` for the same session is a no-op for
   * the rest of the turn — without re-querying the DB on every event.
   */
  private evaluationSequence:
    | { sessionId: string; nextNumber: number; denied: false }
    | { sessionId: string; denied: true }
    | null = null;

  /**
   * Run a chat turn against the given agent, yielding ChatEvents.
   *
   * The outer `try/catch` guarantees a final `{ type: 'error' }` event
   * is yielded before any unexpected exception escapes. Consumers can
   * trust the iterator always terminates cleanly.
   */
  async *run(request: ChatRequest): ChatStream {
    // `withSpanGenerator` activates the chat.turn span as the OTEL active
    // context across yields. Inner llm.call spans (and any helper-`withSpan`
    // calls inside tool dispatch) become children of this span in OTLP
    // backends — one trace per turn, not fragmented roots. `manualStatus`
    // lets the inner manage error status without breaking the SSE consumer
    // contract (the iterator yields error events; never rejects).
    yield* withSpanGenerator(
      SPAN_CHAT_TURN,
      {
        [GEN_AI_OPERATION_NAME]: 'chat',
        [SUNRISE_USER_ID]: request.userId,
        [SUNRISE_AGENT_SLUG]: request.agentSlug,
      },
      (chatSpan) => this.runInner(chatSpan, request),
      { manualStatus: true }
    );
  }

  /**
   * Inner body of `run()` — owns agent load, conversation load, the tool
   * loop, and the catch-all error handling. Sets `chatSpan` status
   * directly via `setSpanStatus` (the helper opts out via `manualStatus`)
   * so error paths that yield `error` events instead of throwing still
   * mark the span as failed in OTLP backends. Lives behind
   * `withSpanGenerator` so the chat.turn span is active OTEL context for
   * every yield, including each `llm.call` span the tool loop opens.
   */
  private async *runInner(
    chatSpan: Span,
    request: ChatRequest
  ): AsyncGenerator<ChatEvent, void, unknown> {
    const log = request.requestId ? logger.withContext({ requestId: request.requestId }) : logger;
    let conversationId: string | null = null;
    let resolvedProviderSlug: string | null = null;
    let chatSpanError: unknown = undefined;
    try {
      registerBuiltInCapabilities();

      const agent = await this.loadAgent(request.agentSlug);
      // Resolve provider + model once. Empty agent.provider/agent.model fall
      // back to the active provider with a key set + the system default-model
      // map; explicit values pass through unchanged.
      const resolvedBinding = await resolveAgentProviderAndModel(agent, 'chat');
      const resolvedModel = resolvedBinding.model;
      const resolvedFallbackProviders = resolvedBinding.fallbacks;
      setSpanAttributes(chatSpan, {
        [SUNRISE_AGENT_ID]: agent.id,
        [GEN_AI_REQUEST_MODEL]: resolvedModel,
        ...(agent.temperature !== null ? { [GEN_AI_REQUEST_TEMPERATURE]: agent.temperature } : {}),
      });

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

      // Attachment gate — fail fast before persisting a user message or
      // creating a conversation if the request carries attachments that
      // the agent or platform cannot serve. Three orthogonal checks
      // run before any expensive work:
      //   1. Per-agent toggle (`enableImageInput` / `enableDocumentInput`)
      //   2. Org-wide kill switch (`imageInputGloballyEnabled` /
      //      `documentInputGloballyEnabled`)
      //   3. Model capability (`'vision'` / `'documents'`)
      //
      // Each failure produces a discrete SSE error code so the UI can
      // map to a precise user-facing message.
      const attachments = request.attachments ?? [];
      const hasImageAttachments = attachments.some((a) => a.mediaType.startsWith('image/'));
      const hasPdfAttachments = attachments.some((a) => a.mediaType === 'application/pdf');
      if (hasImageAttachments || hasPdfAttachments) {
        // Settings load is cheap (singleton) — only fetched when there
        // are attachments to gate.
        const attachmentSettings = await prisma.aiOrchestrationSettings.findUnique({
          where: { slug: 'global' },
          select: { imageInputGloballyEnabled: true, documentInputGloballyEnabled: true },
        });

        if (hasImageAttachments) {
          if (!agent.enableImageInput) {
            yield errorEvent(
              'IMAGE_DISABLED',
              'Image input is not enabled for this agent. Ask an admin to turn it on.'
            );
            return;
          }
          if (attachmentSettings && attachmentSettings.imageInputGloballyEnabled === false) {
            yield errorEvent(
              'IMAGE_DISABLED',
              'Image input is currently disabled platform-wide. Try again later.'
            );
            return;
          }
        }

        if (hasPdfAttachments) {
          if (!agent.enableDocumentInput) {
            yield errorEvent(
              'PDF_DISABLED',
              'PDF input is not enabled for this agent. Ask an admin to turn it on.'
            );
            return;
          }
          if (attachmentSettings && attachmentSettings.documentInputGloballyEnabled === false) {
            yield errorEvent(
              'PDF_DISABLED',
              'PDF input is currently disabled platform-wide. Try again later.'
            );
            return;
          }
        }

        // Capability gate — the resolved chat model must carry every
        // attachment capability the request needs. Vision and documents
        // are intrinsic chat-model capabilities (no fallback model), so
        // a mismatch is a configuration error the user must resolve.
        const requiredCapabilities: AttachmentCapability[] = [];
        if (hasImageAttachments) requiredCapabilities.push('vision');
        if (hasPdfAttachments) requiredCapabilities.push('documents');
        try {
          await assertModelSupportsAttachments(
            resolvedBinding.providerSlug,
            resolvedModel,
            requiredCapabilities
          );
        } catch (err) {
          if (err instanceof ProviderError && err.code === 'CAPABILITY_NOT_SUPPORTED') {
            if (hasImageAttachments && !hasPdfAttachments) {
              yield errorEvent(
                'IMAGE_NOT_SUPPORTED',
                "This agent's model can't process images. Switch the model to one with vision support."
              );
            } else if (hasPdfAttachments && !hasImageAttachments) {
              yield errorEvent(
                'PDF_NOT_SUPPORTED',
                "This agent's model can't process PDFs. Switch the model to one with document support."
              );
            } else {
              yield errorEvent(
                'IMAGE_NOT_SUPPORTED',
                "This agent's model can't process all of the attached files. Switch the model or remove unsupported attachments."
              );
            }
            return;
          }
          throw err;
        }
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
      setSpanAttributes(chatSpan, { [SUNRISE_CONVERSATION_ID]: conversation.id });
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

      // Log a single `vision` cost row when the turn carries
      // attachments. Fires once per turn, regardless of how the chat
      // call ends (success / error / tool-call iteration), because the
      // platform overhead is per-attachment, not per-completion. Per-
      // token chat cost still rolls up under the `chat` rows downstream.
      if (hasImageAttachments || hasPdfAttachments) {
        const imageCount = attachments.filter((a) => a.mediaType.startsWith('image/')).length;
        const pdfCount = attachments.filter((a) => a.mediaType === 'application/pdf').length;
        void logCost({
          agentId: agent.id,
          conversationId: conversation.id,
          model: resolvedModel,
          provider: resolvedBinding.providerSlug,
          inputTokens: 0,
          outputTokens: 0,
          operation: CostOperation.VISION,
          imageCount,
          pdfCount,
        });
      }

      // Mirror to the evaluation log when this chat turn is running
      // inside an evaluation session. No-op otherwise.
      await this.writeEvaluationLog({
        contextType: request.contextType,
        contextId: request.contextId,
        userId: request.userId,
        eventType: 'user_input',
        content: request.message,
        messageId: userMessage.id,
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
          conversationSummary = await summarizeMessages(
            droppedMessages,
            resolvedBinding.providerSlug,
            resolvedFallbackProviders
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
      const modelInfo = getModel(resolvedModel);
      const contextWindowTokens = agent.maxHistoryTokens ?? modelInfo?.maxContext ?? undefined;

      const { messages: initialMessages, breakdown: initialBreakdown } = buildMessagesAndBreakdown({
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
        modelId: resolvedModel,
      });
      let messages: LlmMessage[] = initialMessages;

      const capabilityDefinitions = await getCapabilityDefinitions(agent.id);
      const toolDefinitions: LlmToolDefinition[] = capabilityDefinitions.map((def) => ({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      }));

      // Admin-only: enrich the input breakdown with tool-definition
      // tokens so the chat UI can attribute scaffolding cost back to
      // capability schemas. Counting the serialised JSON over-estimates
      // slightly (providers strip whitespace), which keeps the strip
      // honest as an upper bound.
      if (request.includeTrace && toolDefinitions.length > 0) {
        const toolsJson = JSON.stringify(toolDefinitions);
        initialBreakdown.toolDefinitions = {
          tokens: estimateTokens(toolsJson, resolvedModel),
          chars: toolsJson.length,
          count: toolDefinitions.length,
          names: toolDefinitions.map((t) => t.name),
          content: toolsJson,
        };
        initialBreakdown.totalEstimated += initialBreakdown.toolDefinitions.tokens;
      }

      const { provider, usedSlug } = await getProviderWithFallbacks(
        resolvedBinding.providerSlug,
        resolvedFallbackProviders
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
      const remainingFallbacks = [...resolvedFallbackProviders];
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

      /**
       * Per-tool diagnostics accumulated across the whole turn. Populated
       * only when `request.includeTrace === true`. Each dispatch (single
       * or parallel branch) pushes one entry. Attached to the terminal
       * assistant message metadata so the post-hoc viewer can render
       * the same `<MessageTrace>` component without replaying the loop.
       */
      const turnToolCalls: ToolCallTrace[] = [];

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
          model: resolvedModel,
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
        // Captured before endLlmSpan so the post-stream logCost calls
        // (lines 746 and 769 below) can correlate cost rows with the
        // successful llm.call span. Empty strings under the no-op tracer.
        let llmTraceId = '';
        let llmSpanId = '';

        while (!streamSucceeded && streamRetries <= MAX_STREAM_RETRIES) {
          // `withSpanGenerator` activates the llm.call span as the OTEL
          // active context across yields, so any helper-`withSpan` calls
          // inside the stream body see it as their parent. Each retry
          // opens a fresh span (matching pre-refactor behaviour) — failed
          // attempts and the eventual successful attempt land as siblings
          // under chat.turn in OTLP backends.
          yield* withSpanGenerator(
            SPAN_LLM_CALL,
            {
              [GEN_AI_OPERATION_NAME]: 'chat',
              [GEN_AI_REQUEST_MODEL]: resolvedModel,
              [GEN_AI_SYSTEM]: currentProviderSlug,
              [SUNRISE_AGENT_ID]: agent.id,
              [SUNRISE_AGENT_SLUG]: agent.slug,
              [SUNRISE_CONVERSATION_ID]: conversation.id,
              [SUNRISE_TOOL_ITERATION]: iteration,
              ...(agent.temperature !== null
                ? { [GEN_AI_REQUEST_TEMPERATURE]: agent.temperature }
                : {}),
            },

            async function* (llmSpan: Span): AsyncGenerator<ChatEvent, void, unknown> {
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
                if (usage) {
                  setSpanAttributes(llmSpan, {
                    [GEN_AI_RESPONSE_MODEL]: resolvedModel,
                    [GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens,
                    [GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
                    [GEN_AI_USAGE_TOTAL_TOKENS]: usage.inputTokens + usage.outputTokens,
                  });
                }
                llmTraceId = llmSpan.traceId();
                llmSpanId = llmSpan.spanId();
                setSpanStatus(llmSpan, { code: 'ok' });
              } catch (streamErr) {
                streamRetries++;
                getBreaker(currentProviderSlug).recordFailure();

                // If aborted, don't retry. Throw to let `withSpanGenerator`
                // record the exception on the span and propagate to the
                // outer try/catch in `runInner`.
                if (
                  streamErr instanceof Error &&
                  (streamErr.name === 'AbortError' || streamErr.message.includes('aborted'))
                ) {
                  setSpanStatus(llmSpan, {
                    code: 'error',
                    message: streamErr instanceof Error ? streamErr.message : 'stream aborted',
                  });
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
                  setSpanStatus(llmSpan, {
                    code: 'error',
                    message: streamErr instanceof Error ? streamErr.message : 'stream failed',
                  });
                  throw streamErr;
                }

                log.warn('Stream failed, retrying with fallback provider', {
                  failedProvider: currentProviderSlug,
                  nextProvider: nextSlug,
                  error: streamErr instanceof Error ? streamErr.message : String(streamErr),
                });

                // Record the failover on the failed span so the OTEL trace
                // shows which provider was tried next. The inner returns
                // normally (we don't throw) so the helper won't auto-record
                // the exception — call `recordSpanException` explicitly so
                // OTLP backends still see the failure on the failed-attempt
                // span.
                setSpanAttributes(llmSpan, {
                  [SUNRISE_PROVIDER_FAILOVER_FROM]: currentProviderSlug,
                  [SUNRISE_PROVIDER_FAILOVER_TO]: nextSlug,
                });
                setSpanStatus(llmSpan, {
                  code: 'error',
                  message: streamErr instanceof Error ? streamErr.message : 'stream failed',
                });
                recordSpanException(llmSpan, streamErr);

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
            },
            { manualStatus: true }
          );
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

            // Citation guard — only meaningful on the terminal turn,
            // because citations accumulate across the tool loop and the
            // model only emits `[N]` markers once it has consumed the
            // augmented tool results. Scan is a no-op when no
            // citations were produced this turn.
            const citationScan = scanCitations(assistantText, citations);
            if (citationScan.flagged) {
              log.warn('Citation guard triggered', {
                agentSlug: request.agentSlug,
                conversationId: conversation.id,
                underCited: citationScan.underCited,
                hallucinatedMarkers: citationScan.hallucinatedMarkers,
                citationCount: citations.length,
              });

              let citationMode: string = agent.citationGuardMode ?? 'log_only';
              if (!agent.citationGuardMode) {
                try {
                  const settings = await getOrchestrationSettings();
                  citationMode = settings.citationGuardMode ?? 'log_only';
                } catch {
                  logger.warn(
                    'Failed to load orchestration settings for citation guard mode, falling back to log_only'
                  );
                }
              }

              if (citationMode === 'block') {
                yield errorEvent(
                  'citation_required',
                  citationScan.underCited
                    ? 'Response was blocked because it did not cite any of the retrieved sources.'
                    : 'Response was blocked because it referenced sources that do not exist.'
                );
                return;
              }
              if (citationMode === 'warn_and_continue') {
                yield {
                  type: 'warning',
                  code: citationScan.underCited ? 'citation_missing' : 'citation_hallucinated',
                  message: citationScan.underCited
                    ? 'The response did not cite any retrieved sources.'
                    : `The response referenced sources that were not retrieved (${citationScan.hallucinatedMarkers.join(', ')}).`,
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
          // TS narrows `usage` (a closure-captured `let`) to its initial
          // `null` value at this point because the closure mutation inside
          // `withSpanGenerator` isn't visible to flow analysis. The cast
          // restores the declared union shape so the `if` guard works.
          const finalUsage = usage as { inputTokens: number; outputTokens: number } | null;
          if (finalUsage) {
            assistantMetadata.tokenUsage = {
              inputTokens: finalUsage.inputTokens,
              outputTokens: finalUsage.outputTokens,
              totalTokens: finalUsage.inputTokens + finalUsage.outputTokens,
            };
          }
          if (isTerminalTurn && citations.length > 0) {
            assistantMetadata.citations = citations;
          }
          // Admin-only: attach per-tool diagnostics to the terminal
          // assistant message so the post-hoc trace viewer can render
          // the same `<MessageTrace>` strip from persisted state.
          if (isTerminalTurn && request.includeTrace && turnToolCalls.length > 0) {
            assistantMetadata.toolCalls = turnToolCalls;
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

          // Mirror to evaluation log only on the terminal turn — interim
          // tool-call turns are stage directions, not the final answer.
          // Citations are snapshotted onto the log's metadata so the
          // judge sees what the answerer cited at this point in time.
          if (isTerminalTurn) {
            await this.writeEvaluationLog({
              contextType: request.contextType,
              contextId: request.contextId,
              userId: request.userId,
              eventType: 'ai_response',
              content: assistantText,
              messageId: assistantMsg.id,
              ...((): {
                tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
              } => {
                const u = usage as { inputTokens: number; outputTokens: number } | null;
                if (!u) return {};
                return {
                  tokenUsage: {
                    inputTokens: u.inputTokens,
                    outputTokens: u.outputTokens,
                    totalTokens: u.inputTokens + u.outputTokens,
                  },
                };
              })(),
              ...(citations.length > 0 ? { metadata: { citations } } : {}),
            });
          }
        }

        if (toolCalls.size === 0) {
          // Cast re-bind: see comment above the assistantMetadata block.
          const u = usage as { inputTokens: number; outputTokens: number } | null;
          if (u) {
            void logCost({
              agentId: agent.id,
              conversationId: conversation.id,
              model: resolvedModel,
              provider: resolvedProviderSlug ?? resolvedBinding.providerSlug,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              operation: CostOperation.CHAT,
              traceId: llmTraceId,
              spanId: llmSpanId,
            });
          }

          getBreaker(usedSlug).recordSuccess();
          if (citations.length > 0) {
            yield { type: 'citations', citations };
          }
          yield buildDoneEvent(
            resolvedModel,
            u,
            resolvedProviderSlug,
            request.includeTrace ? initialBreakdown : undefined
          );
          return;
        }

        // Tool call path — log cost for this LLM turn, then re-check
        // budget before dispatching tools (which will trigger another
        // LLM turn that costs more).
        const turnUsage = usage as { inputTokens: number; outputTokens: number } | null;
        if (turnUsage) {
          void logCost({
            agentId: agent.id,
            conversationId: conversation.id,
            model: resolvedModel,
            provider: resolvedProviderSlug ?? resolvedBinding.providerSlug,
            inputTokens: turnUsage.inputTokens,
            outputTokens: turnUsage.outputTokens,
            operation: CostOperation.CHAT,
            traceId: llmTraceId,
            spanId: llmSpanId,
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
            // Mirror to evaluation log — record the call the LLM tried to make
            // and the unavailable error it received, so the transcript is whole.
            await this.writeEvaluationLog({
              contextType: request.contextType,
              contextId: request.contextId,
              userId: request.userId,
              eventType: 'capability_call',
              capabilitySlug: tc.name,
              inputData: tc.arguments,
            });
            await this.writeEvaluationLog({
              contextType: request.contextType,
              contextId: request.contextId,
              userId: request.userId,
              eventType: 'capability_result',
              capabilitySlug: tc.name,
              outputData: unavailableResult,
            });
            messages = [
              ...messages,
              { role: 'assistant', content: assistantText, toolCalls: [tc] },
              { role: 'tool', content: JSON.stringify(unavailableResult), toolCallId: tc.id },
            ];
            continue;
          }

          yield { type: 'status', message: `Executing ${tc.name}` };

          await this.writeEvaluationLog({
            contextType: request.contextType,
            contextId: request.contextId,
            userId: request.userId,
            eventType: 'capability_call',
            capabilitySlug: tc.name,
            inputData: tc.arguments,
          });

          const dispatchStart = Date.now();
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

          const singleLatencyMs = Date.now() - dispatchStart;
          const singleTrace = request.includeTrace
            ? buildToolCallTrace(tc.name, tc.arguments, augmentedResult, singleLatencyMs)
            : undefined;
          if (singleTrace) turnToolCalls.push(singleTrace);

          yield {
            type: 'capability_result',
            capabilitySlug: tc.name,
            result: augmentedResult,
            ...(singleTrace ? { trace: singleTrace } : {}),
          };

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

          await this.writeEvaluationLog({
            contextType: request.contextType,
            contextId: request.contextId,
            userId: request.userId,
            eventType: 'capability_result',
            capabilitySlug: tc.name,
            outputData: augmentedResult,
            executionTimeMs: singleLatencyMs,
          });

          if (request.contextType && request.contextId) {
            invalidateContext(request.contextType, request.contextId);
          }

          // run_workflow → pending approval: surface a card, persist a
          // synthetic assistant message carrying the marker so a reload
          // restores the pending state, then yield done. The user's
          // next action (approve / reject) advances the conversation
          // via a follow-up message; the LLM does not narrate here.
          const pendingApproval = extractPendingApproval(tc.name, augmentedResult);
          if (pendingApproval) {
            await this.persistMessage({
              conversationId: conversation.id,
              role: 'assistant',
              content: '',
              metadata: { pendingApproval },
            });
            yield { type: 'approval_required', pendingApproval };
          }

          if (result.skipFollowup) {
            getBreaker(usedSlug).recordSuccess();
            if (citations.length > 0) {
              yield { type: 'citations', citations };
            }
            yield buildDoneEvent(
              resolvedModel,
              usage,
              resolvedProviderSlug,
              request.includeTrace ? initialBreakdown : undefined
            );
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

          // Mirror capability_call events for the parallel batch (eval log).
          // Skipped tools also get a capability_call/result pair below.
          for (const tc of dispatchable) {
            await this.writeEvaluationLog({
              contextType: request.contextType,
              contextId: request.contextId,
              userId: request.userId,
              eventType: 'capability_call',
              capabilitySlug: tc.name,
              inputData: tc.arguments,
            });
          }

          const parallelDispatchStart = Date.now();
          const settled = await Promise.allSettled(
            dispatchable.map((tc) =>
              withToolTimeout(
                capabilityDispatcher.dispatch(tc.name, tc.arguments, dispatchContext),
                TOOL_DISPATCH_TIMEOUT_MS,
                tc.name
              )
            )
          );
          const parallelDispatchEndMs = Date.now() - parallelDispatchStart;

          const results: Array<{
            capabilitySlug: string;
            result: unknown;
            trace?: ToolCallTrace;
          }> = [];
          const toolResultMessages: LlmMessage[] = [];
          let anySkipFollowup = false;

          // Process skipped tools first
          for (const { tc, result } of skippedResults) {
            const skippedTrace = request.includeTrace
              ? buildToolCallTrace(tc.name, tc.arguments, result, 0)
              : undefined;
            if (skippedTrace) turnToolCalls.push(skippedTrace);
            results.push({
              capabilitySlug: tc.name,
              result,
              ...(skippedTrace ? { trace: skippedTrace } : {}),
            });
            await this.persistMessage({
              conversationId: conversation.id,
              role: 'tool',
              content: JSON.stringify(result),
              capabilitySlug: tc.name,
              toolCallId: tc.id,
              metadata: { toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments }, result },
            });
            // Mirror to eval log: the LLM did request these, so record the
            // call + the unavailable result.
            await this.writeEvaluationLog({
              contextType: request.contextType,
              contextId: request.contextId,
              userId: request.userId,
              eventType: 'capability_call',
              capabilitySlug: tc.name,
              inputData: tc.arguments,
            });
            await this.writeEvaluationLog({
              contextType: request.contextType,
              contextId: request.contextId,
              userId: request.userId,
              eventType: 'capability_result',
              capabilitySlug: tc.name,
              outputData: result,
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

            const parallelTrace = request.includeTrace
              ? buildToolCallTrace(tc.name, tc.arguments, augmentedResult, parallelDispatchEndMs)
              : undefined;
            if (parallelTrace) turnToolCalls.push(parallelTrace);
            results.push({
              capabilitySlug: tc.name,
              result: augmentedResult,
              ...(parallelTrace ? { trace: parallelTrace } : {}),
            });

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

            // Per-tool wall-clock isn't observable inside Promise.allSettled,
            // so we record the batch end-to-end time on every result. Useful
            // signal for "tool batch was slow"; not useful for per-tool perf.
            await this.writeEvaluationLog({
              contextType: request.contextType,
              contextId: request.contextId,
              userId: request.userId,
              eventType: 'capability_result',
              capabilitySlug: tc.name,
              outputData: augmentedResult,
              executionTimeMs: parallelDispatchEndMs,
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

          // Scan parallel results for any run_workflow pause. Each
          // gets its own synthetic assistant message + approval_required
          // event so the chat surface can render a card per pause. In
          // practice the LLM rarely emits multiple run_workflow calls
          // in one parallel batch, but we don't constrain it.
          for (const r of results) {
            const pa = extractPendingApproval(r.capabilitySlug, r.result);
            if (pa) {
              await this.persistMessage({
                conversationId: conversation.id,
                role: 'assistant',
                content: '',
                metadata: { pendingApproval: pa },
              });
              yield { type: 'approval_required', pendingApproval: pa };
            }
          }

          if (anySkipFollowup) {
            getBreaker(usedSlug).recordSuccess();
            if (citations.length > 0) {
              yield { type: 'citations', citations };
            }
            yield buildDoneEvent(
              resolvedModel,
              usage,
              resolvedProviderSlug,
              request.includeTrace ? initialBreakdown : undefined
            );
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
      // Set chatSpanError up front so every caught-exception path (including
      // ChatError early-return below) marks the chat.turn span as error in
      // the finally. In-try `yield errorEvent(...); return;` paths are
      // application-level outcomes (HTTP 4xx-equivalent) and keep span ok.
      chatSpanError = err;
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
    } finally {
      // `withSpanGenerator` opts out of auto-status via `manualStatus: true`
      // and handles `safeEnd` itself. Map captured `chatSpanError` (the
      // catch above swallows ChatError / ProviderError / generic errors and
      // yields error events instead of rethrowing) to error status here.
      if (chatSpanError !== undefined) {
        setSpanStatus(chatSpan, {
          code: 'error',
          message: chatSpanError instanceof Error ? chatSpanError.message : 'chat failed',
        });
      } else {
        setSpanStatus(chatSpan, { code: 'ok' });
      }
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

  /**
   * Write an `AiEvaluationLog` row when the chat turn is running inside
   * an evaluation context. No-op for any other contextType.
   *
   * Failure here MUST NOT abort the chat turn — eval logs are an audit
   * surface, not part of the user-facing happy path. Errors are logged
   * at warn level and swallowed (same posture as `logCost`).
   *
   * Ownership: the caller's `userId` is verified against the session's
   * `userId` on first write. A mismatch (or a missing session) marks
   * the cache `denied` for the rest of the turn — every subsequent
   * `writeEvaluationLog` for the same session is a silent no-op. This
   * prevents one admin from mirroring chat events into another admin's
   * evaluation session via the `contextId` request body field.
   */
  private async writeEvaluationLog(params: WriteEvaluationLogParams): Promise<void> {
    if (params.contextType !== 'evaluation' || !params.contextId) return;

    const sessionId = params.contextId;

    try {
      if (!this.evaluationSequence || this.evaluationSequence.sessionId !== sessionId) {
        // First write for this session: confirm it exists AND belongs to
        // the calling user. `findFirst({ id, userId })` returns null on
        // either miss — we don't need (or want) to distinguish the two.
        const owned = await prisma.aiEvaluationSession.findFirst({
          where: { id: sessionId, userId: params.userId },
          select: { id: true },
        });
        if (!owned) {
          logger.warn('Evaluation log write denied — session not owned by caller', {
            sessionId,
            userId: params.userId,
            eventType: params.eventType,
          });
          this.evaluationSequence = { sessionId, denied: true };
          return;
        }

        const last = await prisma.aiEvaluationLog.findFirst({
          where: { sessionId },
          orderBy: { sequenceNumber: 'desc' },
          select: { sequenceNumber: true },
        });
        this.evaluationSequence = {
          sessionId,
          nextNumber: (last?.sequenceNumber ?? 0) + 1,
          denied: false,
        };
      }
      if (this.evaluationSequence.denied) return;
      const sequenceNumber = this.evaluationSequence.nextNumber++;

      const data: Prisma.AiEvaluationLogUncheckedCreateInput = {
        sessionId,
        sequenceNumber,
        eventType: params.eventType,
      };
      if (params.content !== undefined) data.content = params.content;
      if (params.messageId !== undefined) data.messageId = params.messageId;
      if (params.capabilitySlug !== undefined) data.capabilitySlug = params.capabilitySlug;
      if (params.inputData !== undefined)
        data.inputData = params.inputData as Prisma.InputJsonValue;
      if (params.outputData !== undefined)
        data.outputData = params.outputData as Prisma.InputJsonValue;
      if (params.executionTimeMs !== undefined) data.executionTimeMs = params.executionTimeMs;
      if (params.tokenUsage !== undefined)
        data.tokenUsage = params.tokenUsage as Prisma.InputJsonValue;
      if (params.metadata !== undefined) data.metadata = params.metadata as Prisma.InputJsonValue;

      await prisma.aiEvaluationLog.create({ data });
    } catch (err) {
      logger.warn('Failed to write evaluation log (non-fatal)', {
        sessionId,
        eventType: params.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Convenience wrapper — most callers will use this. */
export function streamChat(request: ChatRequest): ChatStream {
  return new StreamingChatHandler().run(request);
}

function errorEvent(code: string, message: string): ChatEvent {
  return { type: 'error', code, message };
}

/**
 * Narrow a `run_workflow` capability result to a `PendingApproval`.
 * Returns null for any other capability or for a result that didn't
 * pause. Defensive about shape — the LLM never sees this path so a
 * malformed result indicates a code bug rather than untrusted input.
 */
function extractPendingApproval(slug: string, result: unknown): PendingApproval | null {
  if (slug !== 'run_workflow') return null;
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.success !== true) return null;
  const data = r.data;
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.status !== 'pending_approval') return null;
  if (
    typeof d.executionId !== 'string' ||
    typeof d.stepId !== 'string' ||
    typeof d.prompt !== 'string' ||
    typeof d.expiresAt !== 'string' ||
    typeof d.approveToken !== 'string' ||
    typeof d.rejectToken !== 'string'
  ) {
    return null;
  }
  return {
    executionId: d.executionId,
    stepId: d.stepId,
    prompt: d.prompt,
    expiresAt: d.expiresAt,
    approveToken: d.approveToken,
    rejectToken: d.rejectToken,
  };
}

function buildDoneEvent(
  model: string,
  usage: { inputTokens: number; outputTokens: number } | null,
  providerSlug?: string | null,
  inputBreakdown?: InputBreakdown
): ChatEvent {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const costUsd = usage ? calculateCost(model, inputTokens, outputTokens).totalCostUsd : 0;
  const reconciled = inputBreakdown
    ? reconcileBreakdownToActual(inputBreakdown, inputTokens)
    : undefined;
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
    ...(reconciled ? { inputBreakdown: reconciled } : {}),
  };
}

/**
 * Reconcile the locally-estimated input breakdown against the provider's
 * actual reported `inputTokens` count. The per-section text-token
 * estimates stay as they are (those are attribution — they show how
 * much *content* each part contributes); the leftover delta is moved
 * into `framingOverhead` so the breakdown total is **exactly** equal
 * to the model's reported number.
 *
 * Why this works: the model returns `usage.input_tokens` (OpenAI) /
 * `usage.input_tokens` (Anthropic) on every chat response — that's the
 * authoritative count. Our local estimator is unavoidably imperfect
 * (provider scaffolding around messages, tool-envelope tokens, the
 * provider's exact tokeniser drift). Rather than try to predict every
 * source of drift, we surface it as a single labelled `framingOverhead`
 * row so the popover always sums to the real total.
 */
function reconcileBreakdownToActual(
  breakdown: InputBreakdown,
  actualInputTokens: number
): InputBreakdown {
  if (!actualInputTokens || actualInputTokens <= 0) return breakdown;
  const sumSections =
    breakdown.systemPrompt.tokens +
    (breakdown.contextBlock?.tokens ?? 0) +
    (breakdown.userMemories?.tokens ?? 0) +
    (breakdown.conversationSummary?.tokens ?? 0) +
    (breakdown.conversationHistory?.tokens ?? 0) +
    (breakdown.toolDefinitions?.tokens ?? 0) +
    (breakdown.attachments?.tokens ?? 0) +
    breakdown.userMessage.tokens;
  const overhead = actualInputTokens - sumSections;
  return {
    ...breakdown,
    ...(overhead > 0 ? { framingOverhead: { tokens: overhead, chars: 0 } } : {}),
    totalEstimated: actualInputTokens,
  };
}
