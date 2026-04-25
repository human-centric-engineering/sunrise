/**
 * Tests for StreamingChatHandler / streamChat
 *
 * Covers: agent lookup, budget gating, conversation create/load, context
 * building, happy-path streaming, tool call round-trips, skipFollowup
 * short-circuit, tool loop cap, error surfacing, AbortSignal threading,
 * cost logging, and message persistence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findFirst: vi.fn() },
    aiConversation: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), update: vi.fn() },
    aiMessage: { findMany: vi.fn(), create: vi.fn() },
    aiUserMemory: { findMany: vi.fn() },
    aiOrchestrationSettings: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
  getProviderWithFallbacks: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/circuit-breaker', () => ({
  getBreaker: vi.fn(() => ({
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    canAttempt: vi.fn(() => true),
    state: 'closed',
  })),
  resetAllBreakers: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/input-guard', () => ({
  scanForInjection: vi.fn(() => ({ flagged: false, patterns: [] })),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  checkBudget: vi.fn(),
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0.01,
    outputCostUsd: 0.02,
    totalCostUsd: 0.03,
    isLocal: false,
  })),
  logCost: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/orchestration/llm/budget-mutex', () => ({
  withAgentBudgetLock: vi.fn((_id: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities/registry', () => ({
  registerBuiltInCapabilities: vi.fn(),
  getCapabilityDefinitions: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/orchestration/chat/context-builder', () => ({
  buildContext: vi.fn(),
  invalidateContext: vi.fn(),
  clearContextCache: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/output-guard', () => ({
  scanOutput: vi.fn(() => ({ flagged: false, topicMatches: [], builtInMatches: [] })),
}));

vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn(() =>
    Promise.resolve({ inputGuardMode: 'log_only', outputGuardMode: 'log_only' })
  ),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/message-embedder', () => ({
  queueMessageEmbedding: vi.fn(),
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/summarizer', () => ({
  summarizeMessages: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { prisma } = await import('@/lib/db/client');
const { logger } = await import('@/lib/logging');
const { getProviderWithFallbacks, getProvider } =
  await import('@/lib/orchestration/llm/provider-manager');
const { checkBudget, logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
// Registry mocks are established via vi.mock above; no direct assertion needed here.
await import('@/lib/orchestration/capabilities/registry');
const { buildContext, invalidateContext } =
  await import('@/lib/orchestration/chat/context-builder');
const { streamChat } = await import('@/lib/orchestration/chat/streaming-handler');
const { CostOperation } = await import('@/types/orchestration');
const { getBreaker } = await import('@/lib/orchestration/llm/circuit-breaker');
const { scanForInjection } = await import('@/lib/orchestration/chat/input-guard');
const { scanOutput } = await import('@/lib/orchestration/chat/output-guard');
const { getOrchestrationSettings } = await import('@/lib/orchestration/settings');
const { summarizeMessages } = await import('@/lib/orchestration/chat/summarizer');
const { withAgentBudgetLock } = await import('@/lib/orchestration/llm/budget-mutex');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Build a mock provider whose chatStream yields a different script per turn. */
function mockProvider(scripts: unknown[][]) {
  let turn = 0;
  return {
    name: 'mock',
    isLocal: false,
    chat: vi.fn(),
    embed: vi.fn(),
    listModels: vi.fn(),
    testConnection: vi.fn(),
    chatStream: vi.fn(async function* () {
      const chunks = scripts[turn] ?? [];
      turn++;
      for (const c of chunks) yield c;
    }),
  };
}

function makeAgent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'agent-1',
    slug: 'helper',
    name: 'Helper',
    description: 'test',
    systemInstructions: 'You are helpful.',
    systemInstructionsHistory: [],
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    providerConfig: null,
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    metadata: null,
    isActive: true,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conv-1',
    userId: 'u1',
    agentId: 'agent-1',
    title: 'hi',
    contextType: null,
    contextId: null,
    metadata: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'hi',
    metadata: null,
    capabilitySlug: null,
    toolCallId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default request used across most tests
// ---------------------------------------------------------------------------

const baseRequest = {
  message: 'Hello there',
  agentSlug: 'helper',
  userId: 'u1',
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Sensible defaults
  (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
    withinBudget: true,
    spent: 0,
    limit: null,
    remaining: null,
  });
  (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgent());
  (prisma.aiConversation.create as ReturnType<typeof vi.fn>).mockResolvedValue(makeConversation());
  (prisma.aiConversation.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (prisma.aiMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.aiUserMemory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.aiOrchestrationSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.aiConversation.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async ({ data }: { data: Record<string, unknown> }) =>
      makeMessage({ ...data, id: `m_${Math.random()}` })
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamingChatHandler', () => {
  // 1 -----------------------------------------------------------------------
  it('yields error event with agent_not_found when agent does not exist', async () => {
    (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const events = await collect(streamChat(baseRequest));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'agent_not_found' });
    expect(getProviderWithFallbacks).not.toHaveBeenCalled();
    expect(prisma.aiMessage.create).not.toHaveBeenCalled();
  });

  // 2 -----------------------------------------------------------------------
  it('yields error event with budget_exceeded when budget check fails', async () => {
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
      withinBudget: false,
      spent: 100,
      limit: 10,
      remaining: -90,
    });

    const events = await collect(streamChat(baseRequest));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'budget_exceeded' });
    expect(getProviderWithFallbacks).not.toHaveBeenCalled();
    expect(prisma.aiConversation.create).not.toHaveBeenCalled();
    expect(prisma.aiMessage.create).not.toHaveBeenCalled();
  });

  // 3 -----------------------------------------------------------------------
  it('happy path with no tools: yields start, content chunks, done', async () => {
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hello ' },
        { type: 'text', content: 'world!' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const events = await collect(streamChat(baseRequest));

    // Event sequence (status "Thinking..." inserted before LLM turn)
    expect(events[0]).toMatchObject({ type: 'start' });
    expect(events[1]).toMatchObject({ type: 'status', message: 'Thinking...' });
    expect(events[2]).toMatchObject({ type: 'content', delta: 'Hello ' });
    expect(events[3]).toMatchObject({ type: 'content', delta: 'world!' });
    expect(events[4]).toMatchObject({ type: 'done' });
    expect(events).toHaveLength(5);

    // done event carries correct token totals + provider/model
    const done = events[4] as {
      type: 'done';
      tokenUsage: { totalTokens: number };
      costUsd: number;
      provider?: string;
      model?: string;
    };
    expect(done.tokenUsage.totalTokens).toBe(15);
    expect(done.provider).toBe('anthropic');
    expect(done.model).toBe('claude-sonnet-4-6');

    // User message persisted
    const createCalls = (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mock.calls;
    const userCall = createCalls.find((c: any) => c[0].data.role === 'user');
    expect(userCall).toBeDefined();

    // Assistant message persisted with tokenUsage metadata
    const assistantCall: any = createCalls.find((c: any) => c[0].data.role === 'assistant');
    expect(assistantCall).toBeDefined();
    expect(assistantCall[0].data.metadata).toMatchObject({
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    // logCost called once with correct params
    await Promise.resolve();
    await Promise.resolve();
    expect(logCost).toHaveBeenCalledTimes(1);
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: CostOperation.CHAT,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        inputTokens: 10,
        outputTokens: 5,
      })
    );
  });

  // 4 -----------------------------------------------------------------------
  it('creates conversation with correct userId/agentId/title when conversationId omitted', async () => {
    const provider = mockProvider([
      [{ type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const request = { ...baseRequest, message: 'What is the meaning of life?' };
    await collect(streamChat(request));

    expect(prisma.aiConversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          agentId: 'agent-1',
          title: 'What is the meaning of life?',
        }),
      })
    );

    // No contextType/contextId keys when not provided
    const createData = (prisma.aiConversation.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .data;
    expect(createData).not.toHaveProperty('contextType');
    expect(createData).not.toHaveProperty('contextId');
  });

  // 5 -----------------------------------------------------------------------
  it('includes contextType/contextId in conversation create and builds locked context', async () => {
    const lockedCtx = '=== LOCKED CONTEXT ===\nsome data\n=== END LOCKED CONTEXT ===';
    (buildContext as ReturnType<typeof vi.fn>).mockResolvedValue(lockedCtx);

    const provider = mockProvider([
      [{ type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const request = { ...baseRequest, contextType: 'pattern', contextId: '7' };
    await collect(streamChat(request));

    // Conversation created with contextType/contextId
    expect(prisma.aiConversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contextType: 'pattern',
          contextId: '7',
        }),
      })
    );

    // buildContext was called
    expect(buildContext).toHaveBeenCalledWith('pattern', '7');

    // The locked context block was included in the messages passed to chatStream
    const allChatStreamCalls = provider.chatStream.mock.calls as unknown as unknown[][];
    const chatStreamMessages = allChatStreamCalls[0]?.[0] as
      | Array<{ role: string; content: string }>
      | undefined;
    expect(chatStreamMessages).toBeDefined();
    const hasLockedCtx = (chatStreamMessages ?? []).some(
      (m) => m.role === 'system' && m.content.includes('LOCKED CONTEXT')
    );
    expect(hasLockedCtx).toBe(true);
  });

  // 6 -----------------------------------------------------------------------
  it('loads existing conversation when conversationId supplied and returns its id in start event', async () => {
    const existingConv = makeConversation({ id: 'conv-existing' });
    (prisma.aiConversation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(existingConv);

    const provider = mockProvider([
      [{ type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const request = { ...baseRequest, conversationId: 'conv-existing' };
    const events = await collect(streamChat(request));

    expect(prisma.aiConversation.create).not.toHaveBeenCalled();

    const start = events[0] as { type: 'start'; conversationId: string };
    expect(start.type).toBe('start');
    expect(start.conversationId).toBe('conv-existing');
  });

  // 7 -----------------------------------------------------------------------
  it('yields conversation_not_found error when conversationId supplied but row missing', async () => {
    (prisma.aiConversation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const request = { ...baseRequest, conversationId: 'conv-missing' };
    const events = await collect(streamChat(request));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'conversation_not_found' });
    expect(getProviderWithFallbacks).not.toHaveBeenCalled();
  });

  // 8 -----------------------------------------------------------------------
  it('tool call round-trip: dispatches tool, yields capability_result, loops for follow-up', async () => {
    const provider = mockProvider([
      // Turn 1: text + tool_call
      [
        { type: 'text', content: 'Let me check. ' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc1', name: 'search_knowledge_base', arguments: { query: 'react' } },
        },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 3 }, finishReason: 'tool_use' },
      ],
      // Turn 2: final answer
      [
        { type: 'text', content: 'Here is the answer.' },
        { type: 'done', usage: { inputTokens: 30, outputTokens: 8 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { results: [] },
    });

    const events = await collect(streamChat(baseRequest));

    // Event sequence (status "Thinking..." inserted before each LLM turn)
    expect(events[0]).toMatchObject({ type: 'start' });
    expect(events[1]).toMatchObject({ type: 'status', message: 'Thinking...' });
    expect(events[2]).toMatchObject({ type: 'content', delta: 'Let me check. ' });
    expect(events[3]).toMatchObject({ type: 'status', message: 'Executing search_knowledge_base' });
    expect(events[4]).toMatchObject({
      type: 'capability_result',
      capabilitySlug: 'search_knowledge_base',
    });
    expect(events[5]).toMatchObject({ type: 'status', message: 'Processing tool results...' });
    expect(events[6]).toMatchObject({ type: 'content', delta: 'Here is the answer.' });
    expect(events[7]).toMatchObject({ type: 'done' });

    // Dispatcher called with correct args
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge_base',
      { query: 'react' },
      expect.objectContaining({ userId: 'u1', agentId: 'agent-1', conversationId: 'conv-1' })
    );

    // Message persistence: user + turn1 assistant + tool row + turn2 assistant = 4
    const createCalls = (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(createCalls).toHaveLength(4);

    const userMsgs = createCalls.filter((c: any) => c[0].data.role === 'user');
    const assistantMsgs = createCalls.filter((c: any) => c[0].data.role === 'assistant');
    const toolMsgs = createCalls.filter((c: any) => c[0].data.role === 'tool');

    expect(userMsgs).toHaveLength(1);
    expect(assistantMsgs).toHaveLength(2);
    expect(toolMsgs).toHaveLength(1);

    // Tool row carries capabilitySlug and toolCallId
    expect((toolMsgs[0] as any)[0].data).toMatchObject({
      capabilitySlug: 'search_knowledge_base',
      toolCallId: 'tc1',
    });

    // logCost called once per LLM turn that captured usage (both turns do).
    await Promise.resolve();
    await Promise.resolve();
    expect(logCost).toHaveBeenCalledTimes(2);
  });

  // 9 -----------------------------------------------------------------------
  it('skipFollowup short-circuit: yields done after capability_result without a second LLM turn', async () => {
    const provider = mockProvider([
      [
        { type: 'text', content: 'Checking now. ' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc2', name: 'do_thing', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 1 }, finishReason: 'tool_use' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { cost: 0.05 },
      skipFollowup: true,
    });

    const events = await collect(streamChat(baseRequest));

    const types = (events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('capability_result');
    expect(types).toContain('done');
    // chatStream called exactly once — no second turn
    expect(provider.chatStream).toHaveBeenCalledTimes(1);

    // No turn-2 assistant message
    const createCalls = (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mock.calls;
    const assistantMsgs = createCalls.filter((c: any) => c[0].data.role === 'assistant');
    // Only turn-1 assistant (the "Checking now. " text)
    expect(assistantMsgs).toHaveLength(1);
  });

  // 10 ----------------------------------------------------------------------
  it('tool loop cap: yields error after MAX_TOOL_ITERATIONS and warns logger', async () => {
    // Provider always yields a tool_call, dispatcher never returns skipFollowup
    const toolScript = [
      { type: 'text', content: 'Working. ' },
      { type: 'tool_call', toolCall: { id: 'tc', name: 'loop_tool', arguments: {} } },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'tool_use' },
    ];
    const provider = mockProvider(Array.from({ length: 10 }, () => toolScript));
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {},
    });

    const events = await collect(streamChat(baseRequest));

    const last = events[events.length - 1] as { type: string; code: string };
    expect(last.type).toBe('error');
    expect(last.code).toBe('tool_loop_cap');

    // chatStream called exactly MAX_TOOL_ITERATIONS (5) times
    expect(provider.chatStream).toHaveBeenCalledTimes(5);

    // logger.warn called with message containing 'iteration cap'
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('iteration cap'),
      expect.anything()
    );
  });

  // 11 ----------------------------------------------------------------------
  it('provider throws mid-stream: yields start then internal_error, terminates cleanly', async () => {
    const provider = {
      name: 'mock',
      isLocal: false,
      chat: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn(),
      chatStream: vi.fn(() => {
        throw new Error('SECRET_PROD_HOSTNAME network down');
      }),
    };
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    // collect() must return without throwing
    const events = await collect(streamChat(baseRequest));

    const types = (events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('error');

    const err = events.find((e) => (e as { type: string }).type === 'error') as {
      type: 'error';
      code: string;
      message: string;
    };
    expect(err.code).toBe('internal_error');
    // Sanitization: the catch-all must emit a generic message — NOT the
    // raw err.message, which can leak Prisma internals, provider SDK
    // details, or internal hostnames to the client.
    expect(err.message).toBe('An unexpected error occurred');
    expect(err.message).not.toContain('SECRET_PROD_HOSTNAME');
    expect(err.message).not.toContain('network down');

    // The detailed error is still captured in server logs.
    expect(logger.error).toHaveBeenCalled();
  });

  // 12 ----------------------------------------------------------------------
  it('requires_approval with skipFollowup: yields capability_result and done without second LLM turn', async () => {
    const provider = mockProvider([
      [
        { type: 'text', content: 'Let me escalate. ' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc3', name: 'admin_action', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 1 }, finishReason: 'tool_use' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: { code: 'requires_approval', message: 'admin approval needed' },
      skipFollowup: true,
    });

    const events = await collect(streamChat(baseRequest));

    const types = (events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('capability_result');
    expect(types).toContain('done');

    // capability_result carries the failure result
    const capResult = events.find((e) => (e as { type: string }).type === 'capability_result') as {
      type: 'capability_result';
      result: { success: boolean };
    };
    expect(capResult.result).toMatchObject({ success: false });

    // Only one chatStream call — no follow-up
    expect(provider.chatStream).toHaveBeenCalledTimes(1);

    // Tool message was still persisted
    const createCalls = (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mock.calls;
    const toolMsgs = createCalls.filter((c: any) => c[0].data.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
  });

  // 13 ----------------------------------------------------------------------
  it('invalidateContext called after tool call when contextType/contextId are set', async () => {
    (buildContext as ReturnType<typeof vi.fn>).mockResolvedValue('=== LOCKED CONTEXT ===\ndata');
    (prisma.aiConversation.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConversation({ contextType: 'pattern', contextId: '5' })
    );

    const provider = mockProvider([
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc4', name: 'some_tool', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 2, outputTokens: 0 }, finishReason: 'tool_use' },
      ],
      [
        { type: 'text', content: 'Done.' },
        { type: 'done', usage: { inputTokens: 2, outputTokens: 1 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {},
    });

    const request = { ...baseRequest, contextType: 'pattern', contextId: '5' };
    await collect(streamChat(request));

    expect(invalidateContext).toHaveBeenCalledWith('pattern', '5');
  });

  // 14 ----------------------------------------------------------------------
  it('logCost called once per turn that reaches a done chunk', async () => {
    // Single-turn completes: logCost fires once
    const provider1 = mockProvider([
      [{ type: 'done', usage: { inputTokens: 3, outputTokens: 3 }, finishReason: 'stop' }],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: provider1,
      usedSlug: 'anthropic',
    });

    await collect(streamChat(baseRequest));

    await Promise.resolve();
    await Promise.resolve();
    expect(logCost).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Reset defaults after clearAllMocks
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
      withinBudget: true,
      spent: 0,
      limit: null,
      remaining: null,
    });
    (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeAgent());
    (prisma.aiConversation.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConversation()
    );
    (prisma.aiConversation.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.aiMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.aiUserMemory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.aiOrchestrationSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      async ({ data }: { data: Record<string, unknown> }) =>
        makeMessage({ ...data, id: `m_${Math.random()}` })
    );

    // Two-turn scenario: turn 1 (tool call) and turn 2 (final) both reach a
    // `done` chunk, so logCost fires twice — once per LLM turn.
    const provider2 = mockProvider([
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc5', name: 'tool_a', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 1 }, finishReason: 'tool_use' },
      ],
      [{ type: 'done', usage: { inputTokens: 5, outputTokens: 2 }, finishReason: 'stop' }],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: provider2,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {},
    });

    await collect(streamChat(baseRequest));

    await Promise.resolve();
    await Promise.resolve();
    expect(logCost).toHaveBeenCalledTimes(2);
  });

  // 15 ----------------------------------------------------------------------
  it('user message persisted before provider is called (even when provider throws)', async () => {
    const provider = {
      name: 'mock',
      isLocal: false,
      chat: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn(),
      chatStream: vi.fn(() => {
        throw new Error('crash');
      }),
    };
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    await collect(streamChat(baseRequest));

    const createCalls = (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mock.calls;
    const userMsg: any = createCalls.find((c: any) => c[0].data.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg[0].data.content).toBe('Hello there');
  });

  // 16 ----------------------------------------------------------------------
  it('no assistant row persisted for turn 1 when tool_call arrives before any text', async () => {
    const provider = mockProvider([
      // Turn 1: no text, just tool_call then done
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc6', name: 'silent_tool', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 0 }, finishReason: 'tool_use' },
      ],
      // Turn 2: text then done
      [
        { type: 'text', content: 'Result processed.' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 2 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {},
    });

    await collect(streamChat(baseRequest));

    const createCalls = (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mock.calls;
    const assistantMsgs = createCalls.filter((c: any) => c[0].data.role === 'assistant');
    // Turn-2 produces an assistant row, turn-1 should NOT (empty text)
    expect(assistantMsgs).toHaveLength(1);
  });

  // 17 ----------------------------------------------------------------------
  it('AbortSignal is threaded through to chatStream options', async () => {
    const ac = new AbortController();
    const signal = ac.signal;

    const provider = mockProvider([
      [{ type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const request = { ...baseRequest, signal };
    await collect(streamChat(request));

    // chatStream was called and its options include the signal
    expect(provider.chatStream).toHaveBeenCalled();
    const opts = (provider.chatStream.mock.calls[0] as unknown as unknown[])[1] as {
      signal?: AbortSignal;
    };
    expect(opts.signal).toBe(signal);
  });

  // 18 — Budget warning at 80% ---------------------------------------------------
  it('yields a warning event when budget is at 85%', async () => {
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
      withinBudget: true,
      spent: 85,
      limit: 100,
      remaining: 15,
    });
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hi' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const events = await collect(streamChat(baseRequest));
    const types = (events as Array<{ type: string }>).map((e) => e.type);

    expect(types).toContain('warning');
    const warning = (events as Array<{ type: string; code?: string }>).find(
      (e) => e.type === 'warning'
    );
    expect(warning).toMatchObject({ type: 'warning', code: 'budget_warning' });
    // Stream should continue with start and done
    expect(types).toContain('start');
    expect(types).toContain('done');
  });

  // 19 — No warning below 80% ---------------------------------------------------
  it('does not yield a warning event when budget is at 50%', async () => {
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
      withinBudget: true,
      spent: 50,
      limit: 100,
      remaining: 50,
    });
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hi' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const events = await collect(streamChat(baseRequest));
    const types = (events as Array<{ type: string }>).map((e) => e.type);

    expect(types).not.toContain('warning');
  });

  // 20 — Provider exhaustion yields internal_error --------------------------------
  it('yields internal_error when getProviderWithFallbacks throws', async () => {
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('All providers are unavailable')
    );

    const events = await collect(streamChat(baseRequest));

    // The generic catch surfaces internal_error (never the raw message)
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'error', code: 'internal_error' })])
    );
  });

  // 21 — Circuit breaker recordSuccess on completion --------------------------------
  it('calls circuit breaker recordSuccess on successful completion', async () => {
    const mockRecordSuccess = vi.fn();
    (getBreaker as ReturnType<typeof vi.fn>).mockReturnValue({
      recordSuccess: mockRecordSuccess,
      recordFailure: vi.fn(),
      canAttempt: vi.fn(() => true),
      state: 'closed',
    });
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hi' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    await collect(streamChat(baseRequest));

    expect(mockRecordSuccess).toHaveBeenCalled();
  });

  // 22 — Input guard is called with user message -----------------------------------
  it('calls scanForInjection with the user message', async () => {
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hi' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    await collect(streamChat(baseRequest));

    expect(scanForInjection).toHaveBeenCalledWith('Hello there');
  });

  // 23 — Flagged message triggers logger.warn without content ----------------------
  it('logs a warning when input guard flags a message', async () => {
    (scanForInjection as ReturnType<typeof vi.fn>).mockReturnValue({
      flagged: true,
      patterns: ['system_override'],
    });
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hi' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    await collect(streamChat(baseRequest));

    expect(logger.warn).toHaveBeenCalledWith(
      'Potential prompt injection detected',
      expect.objectContaining({
        patterns: ['system_override'],
      })
    );
    // The logged object must NOT contain the message content
    const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'Potential prompt injection detected'
    );
    expect(warnCall?.[1]).not.toHaveProperty('message');
    expect(warnCall?.[1]).not.toHaveProperty('content');
  });

  // 24 ----------------------------------------------------------------------
  it('streamChat() wrapper is equivalent to new StreamingChatHandler().run()', async () => {
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hi!' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const stream = streamChat(baseRequest);
    // The return value must be iterable
    expect(typeof stream[Symbol.asyncIterator]).toBe('function');

    const events = await collect(stream);
    const types = (events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('done');
  });

  // 25 — Trailing text suppression after tool call --------------------------------
  it('suppresses text chunks that arrive after a tool_call in the same turn', async () => {
    // Stream emits: text("before "), tool_call, text("after"), done
    // "after" must be suppressed — not yielded to consumer, not persisted.
    const provider = mockProvider([
      // Turn 1: text before tool, then tool_call, then trailing text, then done
      [
        { type: 'text', content: 'before ' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-trail', name: 'search_knowledge_base', arguments: { query: 'x' } },
        },
        { type: 'text', content: 'after' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 4 }, finishReason: 'tool_use' },
      ],
      // Turn 2: follow-up answer
      [
        { type: 'text', content: 'Done.' },
        { type: 'done', usage: { inputTokens: 12, outputTokens: 3 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { results: [] },
    });

    const events = await collect(streamChat(baseRequest));

    // Consumer must NOT see a content event carrying "after"
    const contentEvents = (events as Array<{ type: string; delta?: string }>).filter(
      (e) => e.type === 'content'
    );
    const deltas = contentEvents.map((e) => e.delta ?? '');
    expect(deltas).not.toContain('after');
    // The pre-tool text IS visible
    expect(deltas).toContain('before ');

    // The persisted turn-1 assistant message must contain only "before "
    const createCalls = (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mock.calls;
    const assistantMsgs = createCalls.filter((c: any) => c[0].data.role === 'assistant');
    // Turn-1 assistant content should be exactly "before "
    const turn1Content: string = (assistantMsgs[0] as any)[0].data.content as string;
    expect(turn1Content).toBe('before ');
    expect(turn1Content).not.toContain('after');

    // The tool call still dispatched normally
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge_base',
      { query: 'x' },
      expect.objectContaining({ agentId: 'agent-1' })
    );

    // Both LLM turns executed
    expect(provider.chatStream).toHaveBeenCalledTimes(2);
  });

  // 26 — requestId correlation: scoped logger when requestId provided ----------------
  it('creates a scoped logger with requestId when provided', async () => {
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hi' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    // The mock logger's withContext should return itself (the mock)
    const scopedLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(),
    };
    (logger as unknown as { withContext: ReturnType<typeof vi.fn> }).withContext = vi
      .fn()
      .mockReturnValue(scopedLogger);

    await collect(streamChat({ ...baseRequest, requestId: 'req-abc-123' }));

    expect(
      (logger as unknown as { withContext: ReturnType<typeof vi.fn> }).withContext
    ).toHaveBeenCalledWith({ requestId: 'req-abc-123' });
  });

  // 27 — buildDoneEvent null usage: zeroed tokens and costUsd=0 ------------------
  it('emits done event with zeroed token counts and costUsd=0 when provider never yields usage', async () => {
    const { calculateCost } = await import('@/lib/orchestration/llm/cost-tracker');

    // Provider yields only text and done-without-usage
    const provider = mockProvider([
      [
        { type: 'text', content: 'Hello!' },
        // done chunk with usage: null simulates the provider omitting usage data
        { type: 'done', usage: null, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const events = await collect(streamChat(baseRequest));

    const done = (events as Array<{ type: string }>).find((e) => e.type === 'done') as {
      type: 'done';
      tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
      costUsd: number;
    };

    expect(done).toBeDefined();
    expect(done.tokenUsage.inputTokens).toBe(0);
    expect(done.tokenUsage.outputTokens).toBe(0);
    expect(done.tokenUsage.totalTokens).toBe(0);
    expect(done.costUsd).toBe(0);

    // calculateCost must NOT have been called — cost is hard-coded 0 when usage is null
    expect(calculateCost).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Parallel tool calling
  // ---------------------------------------------------------------------------

  // 28 ----------------------------------------------------------------------
  it('parallel tool calls: dispatches multiple tool calls concurrently and yields capability_results', async () => {
    const provider = mockProvider([
      // Turn 1: two tool calls in the same turn
      [
        { type: 'text', content: 'Let me look that up. ' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-a', name: 'search_knowledge_base', arguments: { query: 'react' } },
        },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-b', name: 'get_weather', arguments: { city: 'London' } },
        },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 5 }, finishReason: 'tool_use' },
      ],
      // Turn 2: final answer using both tool results
      [
        { type: 'text', content: 'Here are both results.' },
        { type: 'done', usage: { inputTokens: 40, outputTokens: 10 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    let _dispatchCount = 0;
    vi.mocked(capabilityDispatcher.dispatch).mockImplementation((slug: string) => {
      _dispatchCount++;
      return Promise.resolve({ success: true, data: { source: slug } });
    });

    const events = await collect(streamChat(baseRequest));

    // Dispatcher called twice — once per tool call
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge_base',
      { query: 'react' },
      expect.objectContaining({ userId: 'u1', agentId: 'agent-1' })
    );
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'get_weather',
      { city: 'London' },
      expect.objectContaining({ userId: 'u1', agentId: 'agent-1' })
    );

    // Event sequence includes capability_results (plural) with both results
    const capResults = events.find(
      (e) => (e as { type: string }).type === 'capability_results'
    ) as {
      type: 'capability_results';
      results: Array<{ capabilitySlug: string; result: unknown }>;
    };
    expect(capResults).toBeDefined();
    expect(capResults.results).toHaveLength(2);
    expect(capResults.results[0].capabilitySlug).toBe('search_knowledge_base');
    expect(capResults.results[1].capabilitySlug).toBe('get_weather');

    // Two tool messages persisted
    const createCalls = (prisma.aiMessage.create as ReturnType<typeof vi.fn>).mock.calls;
    const toolMsgs = createCalls.filter((c: any) => c[0].data.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect((toolMsgs[0] as any)[0].data.toolCallId).toBe('tc-a');
    expect((toolMsgs[1] as any)[0].data.toolCallId).toBe('tc-b');

    // Second LLM turn received both tool results in messages
    expect(provider.chatStream).toHaveBeenCalledTimes(2);
    const turn2Messages = (
      provider.chatStream.mock.calls[1] as unknown as unknown[][]
    )[0] as Array<{
      role: string;
      toolCallId?: string;
      toolCalls?: unknown[];
    }>;
    // The assistant message should carry both tool calls
    const assistantMsg = turn2Messages.find((m) => m.role === 'assistant' && m.toolCalls);
    expect(assistantMsg?.toolCalls).toHaveLength(2);
    // Both tool result messages should be present
    const toolResultMsgs = turn2Messages.filter((m) => m.role === 'tool');
    expect(toolResultMsgs).toHaveLength(2);

    // Final done event present
    const done = events.find((e) => (e as { type: string }).type === 'done');
    expect(done).toBeDefined();
  });

  // 29 ----------------------------------------------------------------------
  it('parallel tool calls: any skipFollowup result short-circuits after all dispatches', async () => {
    const provider = mockProvider([
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc-x', name: 'tool_a', arguments: {} },
        },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-y', name: 'tool_b', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 1 }, finishReason: 'tool_use' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, data: {} })
      .mockResolvedValueOnce({ success: true, data: {}, skipFollowup: true });

    const events = await collect(streamChat(baseRequest));

    // chatStream only called once — no follow-up turn
    expect(provider.chatStream).toHaveBeenCalledTimes(1);

    const types = (events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('capability_results');
    expect(types).toContain('done');
  });

  // 30 ----------------------------------------------------------------------
  it('parallel tool calls: one rejection in Promise.allSettled returns error result for that tool', async () => {
    const provider = mockProvider([
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc-ok', name: 'good_tool', arguments: {} },
        },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-fail', name: 'bad_tool', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 1 }, finishReason: 'tool_use' },
      ],
      // Turn 2: LLM handles the mixed results
      [
        { type: 'text', content: 'One tool failed.' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 3 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, data: { ok: true } })
      .mockRejectedValueOnce(new Error('Capability crashed'));

    const events = await collect(streamChat(baseRequest));

    const capResults = events.find(
      (e) => (e as { type: string }).type === 'capability_results'
    ) as {
      type: 'capability_results';
      results: Array<{
        capabilitySlug: string;
        result: { success: boolean; error?: { code: string } };
      }>;
    };

    expect(capResults.results[0].result.success).toBe(true);
    expect(capResults.results[1].result.success).toBe(false);
    expect(capResults.results[1].result.error?.code).toBe('execution_error');

    // LLM still gets a follow-up turn with both results
    expect(provider.chatStream).toHaveBeenCalledTimes(2);
  });

  // 31 ----------------------------------------------------------------------
  it('single tool call still uses backward-compatible capability_result event', async () => {
    const provider = mockProvider([
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc-single', name: 'one_tool', arguments: { x: 1 } },
        },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 1 }, finishReason: 'tool_use' },
      ],
      [
        { type: 'text', content: 'Done.' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 2 }, finishReason: 'stop' },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {},
    });

    const events = await collect(streamChat(baseRequest));

    // Should use singular capability_result, NOT capability_results
    const types = (events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('capability_result');
    expect(types).not.toContain('capability_results');
  });

  // ---------------------------------------------------------------------------
  // Mid-stream retry & recovery
  // ---------------------------------------------------------------------------

  describe('Mid-stream retry & recovery', () => {
    it('retries with fallback provider when stream fails mid-turn', async () => {
      const failingProvider = {
        name: 'failing',
        isLocal: false,
        chat: vi.fn(),
        embed: vi.fn(),
        listModels: vi.fn(),
        testConnection: vi.fn(),
        chatStream: vi.fn(async function* () {
          yield { type: 'text', content: 'partial...' };
          throw new Error('Connection reset');
        }),
      };
      const fallbackProvider = mockProvider([
        [
          { type: 'text', content: 'Recovered response' },
          { type: 'done', usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'stop' },
        ],
      ]);

      (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ fallbackProviders: ['openai'] })
      );
      (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
        provider: failingProvider,
        usedSlug: 'anthropic',
      });
      (getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(fallbackProvider);

      const events = await collect(streamChat(baseRequest));
      const types = (events as Array<{ type: string }>).map((e) => e.type);

      // Should emit warning about retry, then content from fallback
      expect(types).toContain('warning');
      const warning = (events as Array<{ type: string; code?: string }>).find(
        (e) => e.type === 'warning' && e.code === 'provider_retry'
      );
      expect(warning).toBeDefined();

      // Should have content from the fallback provider, not the partial
      const contentEvents = (events as Array<{ type: string; delta?: string }>).filter(
        (e) => e.type === 'content'
      );
      // The partial "partial..." is from the failing stream before error;
      // after retry, "Recovered response" from fallback
      expect(contentEvents.some((e) => e.delta === 'Recovered response')).toBe(true);

      expect(types).toContain('done');
      expect(getProvider).toHaveBeenCalledWith('openai');
    });

    it('records circuit breaker failure on stream error before retrying', async () => {
      const failingProvider = {
        name: 'failing',
        isLocal: false,
        chat: vi.fn(),
        embed: vi.fn(),
        listModels: vi.fn(),
        testConnection: vi.fn(),
        // eslint-disable-next-line require-yield
        chatStream: vi.fn(async function* () {
          throw new Error('Provider down');
        }),
      };
      const fallbackProvider = mockProvider([
        [
          { type: 'text', content: 'OK' },
          { type: 'done', usage: { inputTokens: 5, outputTokens: 2 }, finishReason: 'stop' },
        ],
      ]);

      const mockBreaker = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
      (getBreaker as ReturnType<typeof vi.fn>).mockReturnValue(mockBreaker);

      (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ fallbackProviders: ['openai'] })
      );
      (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
        provider: failingProvider,
        usedSlug: 'anthropic',
      });
      (getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(fallbackProvider);

      await collect(streamChat(baseRequest));

      // Circuit breaker should have recorded failure for the failing provider
      expect(mockBreaker.recordFailure).toHaveBeenCalled();
      // And success for the recovered stream
      expect(mockBreaker.recordSuccess).toHaveBeenCalled();
    });

    it('does not retry on AbortError — rethrows immediately', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      const failingProvider = {
        name: 'failing',
        isLocal: false,
        chat: vi.fn(),
        embed: vi.fn(),
        listModels: vi.fn(),
        testConnection: vi.fn(),
        // eslint-disable-next-line require-yield
        chatStream: vi.fn(async function* () {
          throw abortError;
        }),
      };

      (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ fallbackProviders: ['openai'] })
      );
      (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
        provider: failingProvider,
        usedSlug: 'anthropic',
      });

      const events = await collect(streamChat(baseRequest));
      const types = (events as Array<{ type: string }>).map((e) => e.type);

      // start event is emitted before the stream, then internal_error
      expect(types).toContain('start');
      expect(types[types.length - 1]).toBe('error');
      expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'internal_error' });
      // Should NOT call getProvider for fallback
      expect(getProvider).not.toHaveBeenCalled();
    });

    it('surfaces error when no fallback providers remain', async () => {
      const failingProvider = {
        name: 'failing',
        isLocal: false,
        chat: vi.fn(),
        embed: vi.fn(),
        listModels: vi.fn(),
        testConnection: vi.fn(),
        // eslint-disable-next-line require-yield
        chatStream: vi.fn(async function* () {
          throw new Error('Provider error');
        }),
      };

      // No fallback providers
      (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ fallbackProviders: [] })
      );
      (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
        provider: failingProvider,
        usedSlug: 'anthropic',
      });

      const events = await collect(streamChat(baseRequest));
      const last = events[events.length - 1];

      expect(last).toMatchObject({ type: 'error', code: 'internal_error' });
      expect(getProvider).not.toHaveBeenCalled();
    });

    it('surfaces error when fallback provider fails to load', async () => {
      const failingProvider = {
        name: 'failing',
        isLocal: false,
        chat: vi.fn(),
        embed: vi.fn(),
        listModels: vi.fn(),
        testConnection: vi.fn(),
        // eslint-disable-next-line require-yield
        chatStream: vi.fn(async function* () {
          throw new Error('Stream error');
        }),
      };

      (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeAgent({ fallbackProviders: ['openai'] })
      );
      (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
        provider: failingProvider,
        usedSlug: 'anthropic',
      });
      (getProvider as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Provider not configured')
      );

      const events = await collect(streamChat(baseRequest));
      const last = events[events.length - 1];

      expect(last).toMatchObject({ type: 'error', code: 'internal_error' });
    });
  });
});

// ---------------------------------------------------------------------------
// Batch A — Runtime robustness
// ---------------------------------------------------------------------------

describe('mid-loop budget re-check', () => {
  it('yields budget_exceeded when budget is exceeded after a tool call iteration', async () => {
    // Arrange: budget is OK initially, then fails on re-check (after tool iteration)
    let budgetCallCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    (checkBudget as ReturnType<typeof vi.fn>).mockImplementation(() => {
      budgetCallCount++;
      if (budgetCallCount === 1) {
        return Promise.resolve({ withinBudget: true, spent: 5, limit: 10, remaining: 5 });
      }
      return Promise.resolve({ withinBudget: false, spent: 11, limit: 10, remaining: -1 });
    });

    // Tool call script: LLM calls a tool, then the budget check should fire before next iteration
    const provider = mockProvider([
      [
        { type: 'tool_call', toolCall: { id: 'tc1', name: 'search', arguments: {} } },
        { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: 'result',
    });

    const events = await collect(streamChat(baseRequest));
    const errorEvt = events.find((e: unknown) => (e as Record<string, unknown>).type === 'error');

    expect(errorEvt).toMatchObject({
      type: 'error',
      code: 'budget_exceeded',
    });
    expect(budgetCallCount).toBe(2);
  });

  it('acquires budget lock for mid-loop re-check (not just initial check)', async () => {
    // Arrange: budget OK on initial and mid-loop check; tool call triggers mid-loop path
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
      withinBudget: true,
      spent: 5,
      limit: 100,
      remaining: 95,
    });

    const provider = mockProvider([
      [
        { type: 'tool_call', toolCall: { id: 'tc1', name: 'search', arguments: {} } },
        { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } },
      ],
      [
        { type: 'text', content: 'Done.' },
        { type: 'done', usage: { inputTokens: 50, outputTokens: 20 } },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: 'result',
    });

    // Act
    vi.mocked(withAgentBudgetLock).mockClear();
    await collect(streamChat(baseRequest));

    // Assert: lock acquired at least twice — once for initial check, once for mid-loop
    expect(vi.mocked(withAgentBudgetLock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('output guard ordering', () => {
  it('does not log cost when output guard blocks the response', async () => {
    // Arrange: output guard flags the response and agent has block mode
    (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgent({ outputGuardMode: 'block', topicBoundaries: ['forbidden-topic'] })
    );
    (scanOutput as ReturnType<typeof vi.fn>).mockReturnValue({
      flagged: true,
      topicMatches: ['forbidden-topic'],
      builtInMatches: [],
    });

    const provider = mockProvider([
      [
        { type: 'text', content: 'This mentions forbidden-topic.' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    const events = await collect(streamChat(baseRequest));
    const errorEvt = events.find((e: unknown) => (e as Record<string, unknown>).type === 'error');

    expect(errorEvt).toMatchObject({ type: 'error', code: 'output_blocked' });
    // logCost should NOT have been called because guard blocked before cost logging
    expect(logCost).not.toHaveBeenCalled();
  });
});

describe('guard mode fallback logging', () => {
  it('logs warning when settings fetch fails and falls back to log_only', async () => {
    // Arrange: input guard flags, agent has no override, settings fetch fails
    (scanForInjection as ReturnType<typeof vi.fn>).mockReturnValue({
      flagged: true,
      patterns: ['system_override'],
    });
    (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgent({ inputGuardMode: null })
    );
    (getOrchestrationSettings as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Settings unavailable')
    );

    const provider = mockProvider([
      [
        { type: 'text', content: 'Hello' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    await collect(streamChat(baseRequest));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load orchestration settings for input guard mode')
    );
  });

  it('skips tool after 2 consecutive failures (backoff)', async () => {
    const { getCapabilityDefinitions } = await import('@/lib/orchestration/capabilities/registry');
    (getCapabilityDefinitions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'flaky_tool', description: 'Flaky', parameters: {} },
    ]);

    // 3 LLM turns: each requests the same tool. The tool fails on turn 1 and 2,
    // so by turn 3 it should be skipped (threshold = 2).
    const provider = mockProvider([
      // Turn 1: tool call
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc1', name: 'flaky_tool', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      // Turn 2: tool call again
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc2', name: 'flaky_tool', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      // Turn 3: tool call again — should be skipped
      [
        {
          type: 'tool_call',
          toolCall: { id: 'tc3', name: 'flaky_tool', arguments: {} },
        },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      // Turn 4: final text answer after tool unavailable
      [
        { type: 'text', content: 'Done.' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    // Tool fails every time
    (capabilityDispatcher.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: { code: 'execution_error', message: 'boom' },
    });

    const events = await collect(streamChat(baseRequest));

    // The tool should have been dispatched only twice (turns 1 and 2).
    // Turn 3 should skip dispatch and inject tool_unavailable.
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(2);

    // Should log warning about skipping
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping tool after repeated failures',
      expect.objectContaining({ tool: 'flaky_tool', failures: 2 })
    );

    // Should end with a done event
    expect(events[events.length - 1]).toMatchObject({ type: 'done' });
  });
});

// ---------------------------------------------------------------------------
// Input guard mode — block and warn_and_continue branches (L221-231)
// ---------------------------------------------------------------------------

describe('input guard mode dispatch', () => {
  // Helper: provider that yields a normal text response when called.
  function guardTestProvider() {
    return mockProvider([
      [
        { type: 'text', content: 'Hello' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ]);
  }

  it("input guard — guardMode='block' yields input_blocked error event and terminates without calling provider", async () => {
    // Arrange: injection scanner flags the message; agent has no override;
    // settings returns 'block' mode.
    (scanForInjection as ReturnType<typeof vi.fn>).mockReturnValue({
      flagged: true,
      patterns: ['system_override'],
    });
    (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgent({ inputGuardMode: null })
    );
    (getOrchestrationSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      inputGuardMode: 'block',
      outputGuardMode: 'log_only',
    });

    const provider = guardTestProvider();
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    // Act
    const events = await collect(streamChat(baseRequest));

    // Assert: error event with 'input_blocked' code is present
    const errorEvt = events.find(
      (e: unknown) => (e as Record<string, unknown>).type === 'error'
    ) as Record<string, unknown> | undefined;
    expect(errorEvt).toBeDefined();
    expect(errorEvt).toMatchObject({ type: 'error', code: 'input_blocked' });

    // Assert: provider was never invoked — request was short-circuited before LLM call
    expect(provider.chatStream).not.toHaveBeenCalled();
  });

  it("input guard — guardMode='warn_and_continue' yields a warning event then proceeds with the stream", async () => {
    // Arrange: injection scanner flags the message; agent has no override;
    // settings returns 'warn_and_continue' mode.
    (scanForInjection as ReturnType<typeof vi.fn>).mockReturnValue({
      flagged: true,
      patterns: ['system_override'],
    });
    (prisma.aiAgent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAgent({ inputGuardMode: null })
    );
    (getOrchestrationSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      inputGuardMode: 'warn_and_continue',
      outputGuardMode: 'log_only',
    });

    const provider = guardTestProvider();
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    // Act
    const events = await collect(streamChat(baseRequest));

    // Assert: warning event with 'input_flagged' code is present
    const warningEvt = events.find(
      (e: unknown) =>
        (e as Record<string, unknown>).type === 'warning' &&
        (e as Record<string, unknown>).code === 'input_flagged'
    );
    expect(warningEvt).toBeDefined();
    expect(warningEvt).toMatchObject({ type: 'warning', code: 'input_flagged' });

    // Assert: stream completed with a done event — processing continued past warning
    expect(events[events.length - 1]).toMatchObject({ type: 'done' });

    // Assert: provider WAS invoked — message was not blocked
    expect(provider.chatStream).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rolling summarization — history-window exceeded (L243-266)
// ---------------------------------------------------------------------------

describe('rolling conversation summarization', () => {
  // Build MAX_HISTORY_MESSAGES + 2 history rows so droppedCount = 2 > 0.
  // MAX_HISTORY_MESSAGES is 50 (from lib/orchestration/chat/types.ts).
  const HISTORY_SIZE = 52; // 50 + 2

  function makeHistoryMessages(count: number) {
    return Array.from({ length: count }, (_, i) =>
      makeMessage({
        id: `hist-msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        conversationId: 'conv-1',
      })
    );
  }

  it('generates and persists a new summary when historyRows > MAX_HISTORY_MESSAGES and no reusable summary exists', async () => {
    // Arrange: seed 52 messages (> 50 threshold); conversation has no prior summary.
    // Pass conversationId in the request so the existing conversation (with no summary)
    // is loaded via findFirst rather than creating a new one via create.
    const history = makeHistoryMessages(HISTORY_SIZE);
    (prisma.aiMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(history);
    (prisma.aiConversation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConversation({ id: 'conv-summ', summary: null, summaryUpToMessageId: null })
    );
    (summarizeMessages as ReturnType<typeof vi.fn>).mockResolvedValue('summary-text');

    const provider = mockProvider([
      [
        { type: 'text', content: 'Here is my answer.' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    // Act — supply conversationId so that the existing conversation (with summary: null)
    // is loaded via findFirst, not created fresh via create.
    const events = await collect(streamChat({ ...baseRequest, conversationId: 'conv-summ' }));

    // Assert: status event indicating summarization was emitted
    const statusEvts = events.filter(
      (e: unknown) =>
        (e as Record<string, unknown>).type === 'status' &&
        (e as Record<string, unknown>).message === 'Summarizing conversation history...'
    );
    expect(statusEvts.length).toBeGreaterThanOrEqual(1);

    // Assert: summarizeMessages was called exactly once to generate the summary
    expect(summarizeMessages).toHaveBeenCalledTimes(1);

    // Assert: prisma.aiConversation.update was called with the generated summary,
    // filtering by calls that include a 'summary' key in the data argument.
    const updateCalls = (prisma.aiConversation.update as ReturnType<typeof vi.fn>).mock.calls;
    const summaryUpdateCall = updateCalls.find(
      (c: unknown[]) =>
        typeof (c[0] as Record<string, unknown>).data === 'object' &&
        'summary' in ((c[0] as Record<string, unknown>).data as object)
    );
    expect(summaryUpdateCall).toBeDefined();
    expect((summaryUpdateCall![0] as Record<string, unknown>).data).toMatchObject(
      expect.objectContaining({
        summary: 'summary-text',
        summaryUpToMessageId: expect.any(String),
      })
    );

    // Assert: stream ended normally
    expect(events[events.length - 1]).toMatchObject({ type: 'done' });
  });

  it('reuses existing conversation.summary when summaryUpToMessageId matches the last dropped message id', async () => {
    // Arrange: seed 52 messages; conversation already has a summary covering the
    // first 2 dropped messages (droppedCount = 52 - 50 = 2 → lastDropped = history[1]).
    // Pass conversationId so the existing conversation with the cached summary is
    // loaded via findFirst rather than created fresh.
    const history = makeHistoryMessages(HISTORY_SIZE);
    const lastDroppedId = history[1].id; // droppedCount - 1 = index 1
    (prisma.aiMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(history);
    (prisma.aiConversation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeConversation({
        id: 'conv-cached',
        summary: 'cached-text',
        summaryUpToMessageId: lastDroppedId,
      })
    );

    const provider = mockProvider([
      [
        { type: 'text', content: 'Answer using cached context.' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    (getProviderWithFallbacks as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider,
      usedSlug: 'anthropic',
    });

    // Act — supply conversationId so existing conversation with cached summary is loaded
    await collect(streamChat({ ...baseRequest, conversationId: 'conv-cached' }));

    // Assert: summarizeMessages was NOT called — summary was reused from cache
    expect(summarizeMessages).not.toHaveBeenCalled();

    // Assert: no aiConversation.update call included a 'summary' field.
    // There may be other update calls, so we filter by whether 'summary' is in data.
    const updateCalls = (prisma.aiConversation.update as ReturnType<typeof vi.fn>).mock.calls;
    const summaryUpdateCall = updateCalls.find(
      (c: unknown[]) =>
        typeof (c[0] as Record<string, unknown>).data === 'object' &&
        'summary' in ((c[0] as Record<string, unknown>).data as object)
    );
    expect(summaryUpdateCall).toBeUndefined();
  });
});
