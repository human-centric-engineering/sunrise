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
    aiConversation: { findFirst: vi.fn(), create: vi.fn() },
    aiMessage: { findMany: vi.fn(), create: vi.fn() },
    aiUserMemory: { findMany: vi.fn() },
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

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { prisma } = await import('@/lib/db/client');
const { logger } = await import('@/lib/logging');
const { getProviderWithFallbacks } = await import('@/lib/orchestration/llm/provider-manager');
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
  (prisma.aiMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.aiUserMemory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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

    // Event sequence
    expect(events[0]).toMatchObject({ type: 'start' });
    expect(events[1]).toMatchObject({ type: 'content', delta: 'Hello ' });
    expect(events[2]).toMatchObject({ type: 'content', delta: 'world!' });
    expect(events[3]).toMatchObject({ type: 'done' });
    expect(events).toHaveLength(4);

    // done event carries correct token totals
    const done = events[3] as {
      type: 'done';
      tokenUsage: { totalTokens: number };
      costUsd: number;
    };
    expect(done.tokenUsage.totalTokens).toBe(15);

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

    // Event sequence
    expect(events[0]).toMatchObject({ type: 'start' });
    expect(events[1]).toMatchObject({ type: 'content', delta: 'Let me check. ' });
    expect(events[2]).toMatchObject({ type: 'status', message: 'Executing search_knowledge_base' });
    expect(events[3]).toMatchObject({
      type: 'capability_result',
      capabilitySlug: 'search_knowledge_base',
    });
    expect(events[4]).toMatchObject({ type: 'content', delta: 'Here is the answer.' });
    expect(events[5]).toMatchObject({ type: 'done' });

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
    (prisma.aiMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.aiUserMemory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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
});
