/**
 * Integration test — chat handler OTEL span tree
 *
 * Exercises the real `StreamingChatHandler.run` async generator against a
 * `MockTracer` to verify the documented span shape for five scenarios:
 *
 * 1. Single-turn chat (no tool call)
 * 2. Tool-call turn (two llm.call siblings under chat.turn)
 * 3. Mid-stream provider failover
 * 4. ChatError → chat.turn ends with error status
 * 5. Output guard block mode → chat.turn ends with ok status
 *
 * Prisma and every non-trivial collaborator are mocked at the module
 * boundary. No testcontainer is needed because the mock surface covers
 * all DB calls made by the handler.
 *
 * @see lib/orchestration/chat/streaming-handler.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports that trigger the modules
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findFirst: vi.fn() },
    aiConversation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    aiMessage: {
      findMany: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    aiOrchestrationSettings: { findUnique: vi.fn() },
    aiUserMemory: { findMany: vi.fn() },
    aiEvaluationSession: { findFirst: vi.fn() },
    aiEvaluationLog: { findFirst: vi.fn(), create: vi.fn() },
    aiCapability: { findMany: vi.fn() },
    aiAgentCapability: { findMany: vi.fn() },
    aiCostLog: { create: vi.fn() },
    aiProviderConfig: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProviderWithFallbacks: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orchestration/llm/cost-tracker')>(
    '@/lib/orchestration/llm/cost-tracker'
  );
  return {
    ...actual,
    // test-review:accept mock-realism — chat trace-id threading is B2/B3 followup. logCost is
    // stubbed here because the correlation tests (traceId/spanId threading through logCost args)
    // require the mock-tracer infrastructure already in this file; the actual logCost span-ID
    // threading is verified in cost-log-trace-correlation.test.ts (engine path) and the
    // streaming-handler.ts lifting-into-outer-scope is noted as a B2/B3 item in that file.
    logCost: vi.fn().mockResolvedValue(null),
    checkBudget: vi.fn(),
  };
});

vi.mock('@/lib/orchestration/llm/budget-mutex', () => ({
  withAgentBudgetLock: vi
    .fn()
    .mockImplementation(async (_id: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/lib/orchestration/llm/circuit-breaker', () => ({
  getBreaker: vi.fn().mockReturnValue({
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
    canAttempt: vi.fn().mockReturnValue(true),
    reset: vi.fn(),
  }),
}));

vi.mock('@/lib/orchestration/chat/input-guard', () => ({
  scanForInjection: vi.fn().mockReturnValue({ flagged: false, patterns: [] }),
}));

vi.mock('@/lib/orchestration/chat/output-guard', () => ({
  scanOutput: vi.fn().mockReturnValue({ flagged: false }),
  scanCitations: vi.fn().mockReturnValue({ flagged: false }),
}));

vi.mock('@/lib/orchestration/chat/context-builder', () => ({
  buildContext: vi.fn().mockResolvedValue(null),
  invalidateContext: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/message-builder', () => ({
  buildMessages: vi.fn().mockReturnValue([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ]),
}));

vi.mock('@/lib/orchestration/chat/message-embedder', () => ({
  queueMessageEmbedding: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/citations', () => ({
  extractCitations: vi.fn().mockReturnValue({ citations: [], nextMarker: 1, augmentedResult: {} }),
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn().mockResolvedValue({
    inputGuardMode: 'log_only',
    outputGuardMode: 'log_only',
    citationGuardMode: 'log_only',
  }),
}));

vi.mock('@/lib/orchestration/chat/summarizer', () => ({
  summarizeMessages: vi.fn().mockResolvedValue('Summary'),
}));

vi.mock('@/lib/orchestration/capabilities/registry', () => ({
  registerBuiltInCapabilities: vi.fn(),
  getCapabilityDefinitions: vi.fn().mockResolvedValue([]),
  __resetRegistrationForTests: vi.fn(),
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: {
    dispatch: vi.fn(),
    register: vi.fn(),
    clearCache: vi.fn(),
    loadFromDatabase: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn().mockReturnValue(null),
  getAvailableModels: vi.fn().mockReturnValue([]),
  computeDefaultModelMap: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { prisma } from '@/lib/db/client';
import { getProviderWithFallbacks, getProvider } from '@/lib/orchestration/llm/provider-manager';
import { checkBudget, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { scanOutput } from '@/lib/orchestration/chat/output-guard';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { StreamingChatHandler } from '@/lib/orchestration/chat/streaming-handler';
import type { ChatEvent } from '@/types/orchestration';
import type { ChatRequest } from '@/lib/orchestration/chat/types';
import { MockTracer, findSpan } from '@/tests/helpers/mock-tracer';
import { registerTracer, resetTracer } from '@/lib/orchestration/tracing/registry';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = 'agent_test_1';
const AGENT_SLUG = 'test-agent';
const USER_ID = 'user_test_1';
const CONVERSATION_ID = 'conv_test_1';
const MESSAGE_ID = 'msg_test_1';
const ASSISTANT_MSG_ID = 'msg_asst_1';

/** Minimal agent shape the handler reads. */
const makeAgent = (overrides: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  slug: AGENT_SLUG,
  model: 'gpt-4o-mini',
  provider: 'openai',
  temperature: 0.7,
  maxTokens: 1000,
  systemInstructions: 'You are helpful.',
  isActive: true,
  fallbackProviders: [],
  topicBoundaries: [],
  outputGuardMode: 'log_only',
  citationGuardMode: 'log_only',
  inputGuardMode: 'log_only',
  brandVoiceInstructions: null,
  maxHistoryTokens: null,
  metadata: null,
  ...overrides,
});

/** Minimal conversation shape. */
const makeConversation = (overrides: Record<string, unknown> = {}) => ({
  id: CONVERSATION_ID,
  userId: USER_ID,
  agentId: AGENT_ID,
  isActive: true,
  title: 'Hello',
  summary: null,
  summaryUpToMessageId: null,
  contextType: null,
  contextId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** Minimal AiMessage shape returned by create(). */
const makeMessage = (role: string, overrides: Record<string, unknown> = {}) => ({
  id: role === 'user' ? MESSAGE_ID : ASSISTANT_MSG_ID,
  conversationId: CONVERSATION_ID,
  role,
  content: 'Hello',
  capabilitySlug: null,
  toolCallId: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** Build a mock provider returning a simple text + done stream. */
function makeMockProvider(
  chunks: Array<{ type: string; content?: string; toolCall?: unknown; usage?: unknown }>,
  slug = 'openai'
) {
  return {
    name: slug,
    isLocal: false,
    // Use mockImplementation so each call creates a fresh generator instance.
    // mockReturnValue would share a single exhausted iterator across multiple
    // chatStream calls (e.g. tool-call tests that call chatStream twice).
    chatStream: vi.fn().mockImplementation(() =>
      (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })()
    ),
    chat: vi.fn(),
    embed: vi.fn(),
    listModels: vi.fn(),
    testConnection: vi.fn(),
  };
}

/** Default happy-path request. */
const makeRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  message: 'Hello',
  agentSlug: AGENT_SLUG,
  userId: USER_ID,
  ...overrides,
});

/** Drain the async iterator into an array of events. */
async function collectChat(
  handler: StreamingChatHandler,
  request: ChatRequest
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const ev of handler.run(request)) {
    events.push(ev);
  }
  return events;
}

/** Set up the default DB mocks for the happy-path scenario. */
function setupDefaultPrismaMocks() {
  vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(makeAgent() as never);
  vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.aiConversation.create).mockResolvedValue(makeConversation() as never);
  vi.mocked(prisma.aiConversation.findFirst).mockResolvedValue(makeConversation() as never);
  vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
  vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([]);
  vi.mocked(prisma.aiMessage.count).mockResolvedValue(0);
  vi.mocked(prisma.aiMessage.create)
    .mockResolvedValueOnce(makeMessage('user') as never)
    .mockResolvedValue(makeMessage('assistant') as never);
  vi.mocked(prisma.aiUserMemory.findMany).mockResolvedValue([]);
}

/** Set up default budget mock: within budget, no limit. */
function setupDefaultBudget() {
  vi.mocked(checkBudget).mockResolvedValue({
    withinBudget: true,
    spent: 0,
    limit: null,
    remaining: null,
  } as never);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const tracer = new MockTracer();

describe('StreamingChatHandler — OTEL span tree (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tracer.reset();
    resetTracer();
    registerTracer(tracer);

    setupDefaultPrismaMocks();
    setupDefaultBudget();
  });

  afterEach(() => {
    resetTracer();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Single-turn chat — no tool call
  // -------------------------------------------------------------------------

  it('single-turn chat emits chat.turn → llm.call with usage attributes', async () => {
    // Arrange: provider returns text + done; no tool calls
    const mockProvider = makeMockProvider([
      { type: 'text', content: 'hello' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } },
    ]);
    vi.mocked(getProviderWithFallbacks).mockResolvedValue({
      provider: mockProvider as never,
      usedSlug: 'openai',
    });

    // Act
    const handler = new StreamingChatHandler();
    const events = await collectChat(handler, makeRequest());

    // Assert — events include content and done
    const contentEvents = events.filter((e) => e.type === 'content');
    const doneEvent = events.find((e) => e.type === 'done');
    expect(contentEvents.length).toBeGreaterThan(0);
    expect(doneEvent).toBeDefined();

    // Assert — chat.turn span: ok status, documented attributes
    const chatSpan = findSpan(tracer.spans, 'chat.turn');
    expect(chatSpan.status?.code).toBe('ok');
    expect(chatSpan.attributes['sunrise.user_id']).toBe(USER_ID);
    expect(chatSpan.attributes['sunrise.agent_slug']).toBe(AGENT_SLUG);
    expect(chatSpan.attributes['sunrise.agent_id']).toBe(AGENT_ID);
    expect(chatSpan.attributes['sunrise.conversation_id']).toBe(CONVERSATION_ID);
    expect(chatSpan.attributes['gen_ai.request.model']).toBe('gpt-4o-mini');

    // Assert — llm.call span: ok status, correct system/token attributes
    const llmSpan = findSpan(tracer.spans, 'llm.call');
    expect(llmSpan.status?.code).toBe('ok');
    expect(llmSpan.attributes['gen_ai.system']).toBe('openai');
    expect(llmSpan.attributes['gen_ai.usage.input_tokens']).toBe(10);
    expect(llmSpan.attributes['gen_ai.usage.output_tokens']).toBe(20);
    expect(llmSpan.attributes['sunrise.tool_iteration']).toBe(1);

    // Assert — exactly one llm.call span was recorded
    expect(tracer.spans.filter((s) => s.name === 'llm.call')).toHaveLength(1);

    // Assert — llm.call nests under chat.turn so OTLP backends render the
    // turn as one trace rather than fragmented roots.
    expect(chatSpan.parentSpanId).toBeNull();
    expect(llmSpan.parentSpanId).toBe(chatSpan.spanId);
  });

  // -------------------------------------------------------------------------
  // Test 2: Tool-call turn — two llm.call siblings
  // -------------------------------------------------------------------------

  it('tool-call turn emits two llm.call siblings under chat.turn with tool_iteration attributes', async () => {
    // Arrange: stream 1 has text + tool_call + done; stream 2 has text + done
    const toolCall = {
      id: 'call_1',
      name: 'test_tool',
      arguments: { query: 'hello' },
    };

    const stream1 = (async function* () {
      yield { type: 'text', content: 'Thinking...' };
      yield { type: 'tool_call', toolCall };
      yield { type: 'done', usage: { inputTokens: 15, outputTokens: 5 } };
    })();

    const stream2 = (async function* () {
      yield { type: 'text', content: 'Based on the tool result...' };
      yield { type: 'done', usage: { inputTokens: 20, outputTokens: 30 } };
    })();

    const mockProvider = {
      name: 'openai',
      isLocal: false,
      chatStream: vi.fn().mockReturnValueOnce(stream1).mockReturnValueOnce(stream2),
      chat: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    };

    vi.mocked(getProviderWithFallbacks).mockResolvedValue({
      provider: mockProvider as never,
      usedSlug: 'openai',
    });

    // Tool dispatch returns a deterministic result
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: { answer: '42' },
    } as never);

    // Persist tool message between the two LLM turns
    vi.mocked(prisma.aiMessage.create)
      .mockResolvedValueOnce(makeMessage('user') as never)
      .mockResolvedValueOnce(makeMessage('assistant') as never)
      .mockResolvedValueOnce({ ...makeMessage('tool'), role: 'tool' } as never)
      .mockResolvedValue(makeMessage('assistant') as never);

    // Act
    const handler = new StreamingChatHandler();
    const events = await collectChat(handler, makeRequest());

    // Assert — events include a capability_result and a final done
    expect(events.find((e) => e.type === 'capability_result')).toBeDefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();

    // Assert — chat.turn span: ok status
    const chatSpan = findSpan(tracer.spans, 'chat.turn');
    expect(chatSpan.status?.code).toBe('ok');

    // Assert — exactly two llm.call spans were emitted (one per iteration)
    const llmCalls = tracer.spans.filter((s) => s.name === 'llm.call');
    expect(llmCalls).toHaveLength(2);

    // tool_iteration increments across iterations
    expect(llmCalls[0].attributes['sunrise.tool_iteration']).toBe(1);
    expect(llmCalls[1].attributes['sunrise.tool_iteration']).toBe(2);

    // First call triggered a tool — usage came from the done chunk
    expect(llmCalls[0].attributes['gen_ai.usage.input_tokens']).toBe(15);
    // Second call consumed the tool result
    expect(llmCalls[1].attributes['gen_ai.usage.input_tokens']).toBe(20);
    expect(llmCalls[1].attributes['gen_ai.usage.output_tokens']).toBe(30);

    // Assert — both llm.call spans nest under chat.turn (siblings).
    expect(llmCalls[0].parentSpanId).toBe(chatSpan.spanId);
    expect(llmCalls[1].parentSpanId).toBe(chatSpan.spanId);
  });

  // -------------------------------------------------------------------------
  // Test 3: Mid-stream provider failover
  // -------------------------------------------------------------------------

  it('mid-stream failover produces two llm.call siblings — first error, second ok', async () => {
    // Arrange: stream fails on first attempt, succeeds on second with a fallback provider
    const successStream = (async function* () {
      yield { type: 'text', content: 'Fallback answer' };
      yield { type: 'done', usage: { inputTokens: 12, outputTokens: 8 } };
    })();

    const primaryProvider = {
      name: 'openai',
      isLocal: false,
      chatStream: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('first attempt failed');
        })
        .mockReturnValueOnce(successStream),
      chat: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    };

    const fallbackProvider = {
      name: 'anthropic',
      isLocal: false,
      chatStream: vi.fn().mockReturnValue(successStream),
      chat: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    };

    // Primary via getProviderWithFallbacks, fallback via getProvider after failover
    vi.mocked(getProviderWithFallbacks).mockResolvedValue({
      provider: primaryProvider as never,
      usedSlug: 'openai',
    });
    vi.mocked(getProvider).mockResolvedValue(fallbackProvider as never);

    // Configure agent with a fallback provider
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(
      makeAgent({ fallbackProviders: ['anthropic'] }) as never
    );

    // Act
    const handler = new StreamingChatHandler();
    const events = await collectChat(handler, makeRequest());

    // Assert — chat completes successfully (done event present)
    expect(events.find((e) => e.type === 'done')).toBeDefined();

    // Assert — exactly two llm.call spans were emitted (failed attempt + retry)
    const llmCalls = tracer.spans.filter((s) => s.name === 'llm.call');
    expect(llmCalls).toHaveLength(2);

    // First span: error status, failover attributes, recorded exception
    const failedSpan = llmCalls[0];
    expect(failedSpan.status?.code).toBe('error');
    expect(failedSpan.exceptions).toHaveLength(1);
    expect(failedSpan.attributes['sunrise.provider.failover_from']).toBe('openai');
    expect(failedSpan.attributes['sunrise.provider.failover_to']).toBe('anthropic');

    // Second span: ok status, fallback provider slug, correct token counts
    const successSpan = llmCalls[1];
    expect(successSpan.status?.code).toBe('ok');
    expect(successSpan.attributes['gen_ai.system']).toBe('anthropic');
    expect(successSpan.attributes['gen_ai.usage.input_tokens']).toBe(12);
    expect(successSpan.attributes['gen_ai.usage.output_tokens']).toBe(8);

    // Assert — chat.turn span is ok (the turn ultimately succeeded)
    const chatSpan = findSpan(tracer.spans, 'chat.turn');
    expect(chatSpan.status?.code).toBe('ok');

    // Assert — both failed and successful llm.call spans nest under chat.turn
    // as siblings; failover doesn't break trace correlation.
    expect(failedSpan.parentSpanId).toBe(chatSpan.spanId);
    expect(successSpan.parentSpanId).toBe(chatSpan.spanId);

    // Assert — logCost was called with the SECOND (successful) span's IDs, not the first
    // (failed) span's IDs. A regression that captured span IDs before the retry attempt
    // would silently misattribute the cost row.
    // Guard before index access: if a regression reduces span count the next line
    // would TypeError otherwise, obscuring the real failure.
    expect(llmCalls[1]).toBeDefined();
    const successfulSpan = llmCalls[1]; // second span is the successful retry
    expect(vi.mocked(logCost).mock.calls[0]?.[0]?.spanId).toBe(successfulSpan.spanId);
  });

  // -------------------------------------------------------------------------
  // Test 4: ChatError → chat.turn ends with error status
  // -------------------------------------------------------------------------

  it('ChatError during agent load results in chat.turn span with error status', async () => {
    // Arrange: agent lookup returns null → loadAgent throws ChatError('agent_not_found', ...)
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null);

    // Act
    const handler = new StreamingChatHandler();
    const events = await collectChat(handler, makeRequest({ agentSlug: 'nonexistent-agent' }));

    // Assert — error event was yielded
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: 'error'; code: string }).code).toBe('agent_not_found');

    // Assert — chat.turn span ends with error status (the HIGH fix from 84e15253)
    const chatSpan = findSpan(tracer.spans, 'chat.turn');
    expect(chatSpan.status?.code).toBe('error');

    // Assert — no llm.call spans were started (error happened before provider call)
    const llmCalls = tracer.spans.filter((s) => s.name === 'llm.call');
    expect(llmCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 5: Output guard block mode → chat.turn ends with ok status
  // -------------------------------------------------------------------------

  it('output guard block mode yields error event but chat.turn span ends ok', async () => {
    // Arrange: agent has output guard in block mode; scanOutput flags the response
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(
      makeAgent({ outputGuardMode: 'block' }) as never
    );

    const mockProvider = makeMockProvider([
      { type: 'text', content: 'This response is off-topic.' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 10 } },
    ]);
    vi.mocked(getProviderWithFallbacks).mockResolvedValue({
      provider: mockProvider as never,
      usedSlug: 'openai',
    });

    // Output guard fires and blocks
    vi.mocked(scanOutput).mockReturnValue({
      flagged: true,
      topicMatches: ['off-topic'],
      builtInMatches: [],
    } as never);

    // Act
    const handler = new StreamingChatHandler();
    const events = await collectChat(handler, makeRequest());

    // Assert — error event with output_blocked code was yielded
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: 'error'; code: string }).code).toBe('output_blocked');

    // Assert — chat.turn span ends with ok status (application-level outcome,
    // not a transport failure — the block path returns from inside the try block,
    // so chatSpanError remains undefined and endChatSpan({ code: 'ok' }) is called)
    const chatSpan = findSpan(tracer.spans, 'chat.turn');
    expect(chatSpan.status?.code).toBe('ok');

    // Assert — one llm.call span with ok status (the stream completed before guard triggered)
    const llmCalls = tracer.spans.filter((s) => s.name === 'llm.call');
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].status?.code).toBe('ok');
  });
});
