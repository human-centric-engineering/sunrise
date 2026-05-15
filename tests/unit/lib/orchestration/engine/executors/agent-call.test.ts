/**
 * Tests for `lib/orchestration/engine/executors/agent-call.ts`.
 *
 * Covers:
 *   - Happy path: valid agentSlug + message → output with content/tokens/cost
 *   - Missing agentSlug: throws ExecutorError('missing_agent_slug')
 *   - Missing message: throws ExecutorError('missing_message')
 *   - Agent not found: throws ExecutorError('agent_not_found')
 *   - Provider unavailable: throws ExecutorError('provider_unavailable')
 *   - LLM call failure: throws ExecutorError('agent_call_failed')
 *   - Tool use loop: dispatches capability, appends result, loops back
 *   - Tool skipFollowup: returns tool result as output
 *   - Message interpolation: {{input}} is resolved
 *   - Cost tracking: accumulates across multi-turn tool loops
 *
 * @see lib/orchestration/engine/executors/agent-call.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProviderWithFallbacks: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(),
  logCost: vi.fn(),
}));

vi.mock('@/lib/orchestration/capabilities/registry', () => ({
  registerBuiltInCapabilities: vi.fn(),
  getCapabilityDefinitions: vi.fn(),
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  interpolatePrompt: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeAgentCall } from '@/lib/orchestration/engine/executors/agent-call';
import { prisma } from '@/lib/db/client';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getCapabilityDefinitions } from '@/lib/orchestration/capabilities/registry';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import type { TurnEntry, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { MockTracer } from '@/tests/helpers/mock-tracer';
import { registerTracer, resetTracer } from '@/lib/orchestration/tracing/registry';
import { SPAN_AGENT_CALL_TURN } from '@/lib/orchestration/tracing/attributes';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { query: 'hello' },
    stepOutputs: {},
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      withContext: vi.fn().mockReturnThis(),
    } as unknown as ExecutionContext['logger'],
    ...overrides,
  };
}

function makeStep(configOverrides?: Record<string, unknown>): WorkflowStep {
  return {
    id: 'step1',
    name: 'Test Agent Call',
    type: 'agent_call',
    config: { agentSlug: 'summarizer', message: 'Summarize: {{input}}', ...configOverrides },
    nextSteps: [],
  };
}

const MOCK_AGENT = {
  id: 'agent_1',
  slug: 'summarizer',
  name: 'Summarizer',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  fallbackProviders: [],
  systemInstructions: 'You are a summarizer.',
  temperature: 0.3,
  maxTokens: 1000,
  isActive: true,
};

const mockChat = vi.fn();
const mockProvider = { chat: mockChat };

function setupDefaultMocks(): void {
  vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(MOCK_AGENT as never);
  vi.mocked(resolveAgentProviderAndModel).mockImplementation(async (agent) => ({
    providerSlug: agent.provider || 'anthropic',
    model: agent.model || 'claude-sonnet-4-20250514',
    fallbacks: agent.fallbackProviders ?? [],
  }));
  vi.mocked(getProviderWithFallbacks).mockResolvedValue({
    provider: mockProvider as never,
    usedSlug: 'anthropic',
  });
  vi.mocked(getCapabilityDefinitions).mockResolvedValue([]);
  vi.mocked(interpolatePrompt).mockReturnValue('Summarize: hello');
  vi.mocked(calculateCost).mockReturnValue({
    totalCostUsd: 0.01,
    isLocal: false,
    inputCostUsd: 0.004,
    outputCostUsd: 0.006,
  });
  vi.mocked(logCost).mockResolvedValue(undefined as never);
  mockChat.mockResolvedValue({
    content: 'Summary result',
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: 'stop',
    model: 'claude-sonnet-4-20250514',
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeAgentCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('happy path: returns output, tokensUsed, costUsd', async () => {
    const result = await executeAgentCall(makeStep(), makeCtx());

    expect(result).toEqual({
      output: 'Summary result',
      tokensUsed: 150,
      costUsd: 0.01,
    });
  });

  it('pushes a telemetry entry per provider.chat() turn into ctx.stepTelemetry', async () => {
    const telemetry: import('@/types/orchestration').LlmTelemetryEntry[] = [];
    await executeAgentCall(makeStep(), makeCtx({ stepTelemetry: telemetry }));

    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(telemetry[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('loads the agent by slug', async () => {
    await executeAgentCall(makeStep(), makeCtx());

    expect(prisma.aiAgent.findFirst).toHaveBeenCalledWith({
      where: { slug: 'summarizer', isActive: true },
    });
  });

  it('passes system instructions as first message', async () => {
    await executeAgentCall(makeStep(), makeCtx());

    const messages = mockChat.mock.calls[0][0];
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a summarizer.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Summarize: hello' });
  });

  it('uses agent model and temperature in chat options', async () => {
    await executeAgentCall(makeStep(), makeCtx());

    const options = mockChat.mock.calls[0][1];
    expect(options.model).toBe('claude-sonnet-4-20250514');
    expect(options.temperature).toBe(0.3);
    expect(options.maxTokens).toBe(1000);
  });

  it('interpolates the message template', async () => {
    const ctx = makeCtx();
    await executeAgentCall(makeStep(), ctx);

    expect(interpolatePrompt).toHaveBeenCalledWith('Summarize: {{input}}', ctx);
  });

  it('throws missing_agent_slug when agentSlug is undefined', async () => {
    await expect(
      executeAgentCall(makeStep({ agentSlug: undefined }), makeCtx())
    ).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_agent_slug',
      stepId: 'step1',
    });
  });

  it('throws missing_agent_slug when agentSlug is empty', async () => {
    await expect(executeAgentCall(makeStep({ agentSlug: '' }), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_agent_slug',
    });
  });

  it('throws missing_message when message is undefined', async () => {
    await expect(
      executeAgentCall(makeStep({ message: undefined }), makeCtx())
    ).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_message',
    });
  });

  it('throws missing_message when message is empty', async () => {
    await expect(executeAgentCall(makeStep({ message: '' }), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_message',
    });
  });

  it('throws agent_not_found when agent does not exist', async () => {
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue(null as never);

    await expect(executeAgentCall(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'agent_not_found',
    });
  });

  it('throws provider_unavailable when provider fails', async () => {
    vi.mocked(getProviderWithFallbacks).mockRejectedValue(new Error('No provider'));

    await expect(executeAgentCall(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'provider_unavailable',
    });
  });

  it('resolves empty agent provider/model via resolveAgentProviderAndModel before calling provider manager', async () => {
    // Regression: system-seeded agents (e.g. provider-model-auditor) ship with
    // empty provider/model strings that must be resolved from settings before
    // the executor touches the provider manager. Prior to the fix, the empty
    // slug was passed straight to getProviderWithFallbacks and threw
    // `Provider "" unavailable …`.
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      ...MOCK_AGENT,
      provider: '',
      model: '',
    } as never);
    vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-4o-mini',
      fallbacks: ['anthropic'],
    });

    await executeAgentCall(makeStep(), makeCtx());

    expect(resolveAgentProviderAndModel).toHaveBeenCalled();
    expect(getProviderWithFallbacks).toHaveBeenCalledWith('openai', ['anthropic']);
    expect(mockChat.mock.calls[0][1].model).toBe('gpt-4o-mini');
  });

  it('throws agent_call_failed when chat throws', async () => {
    mockChat.mockRejectedValue(new Error('Rate limited'));

    await expect(executeAgentCall(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'agent_call_failed',
      message: 'Rate limited',
    });
  });

  it('carries partial tokens/cost on ExecutorError when a later turn fails', async () => {
    // Turn 1 succeeds and asks for a tool — its tokens/cost are real and
    // billed via AiCostLog. Turn 2 throws. Without partial-cost on the
    // ExecutorError, those billed tokens become invisible at the row level
    // and the trace header diverges from the per-call cost sub-table.
    mockChat
      .mockResolvedValueOnce({
        content: 'Let me search…',
        toolCalls: [{ id: 'tc_1', name: 'search-knowledge', arguments: { q: 'x' } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        finishReason: 'tool_use',
      })
      .mockRejectedValueOnce(new Error('Provider 503'));

    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: { results: ['anything'] },
    });
    // calculateCost was set up with $0.01 per call in the test fixture.
    await expect(executeAgentCall(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'agent_call_failed',
      tokensUsed: 150, // 100 + 50 from the successful first turn
      costUsd: 0.01, // single calculateCost call before the failure
    });
  });

  it('handles tool call loop: dispatches capability and loops back', async () => {
    // First call: model wants a tool
    mockChat.mockResolvedValueOnce({
      content: 'Let me search...',
      toolCalls: [{ id: 'tc_1', name: 'search-knowledge', arguments: { query: 'test' } }],
      usage: { inputTokens: 50, outputTokens: 30 },
      finishReason: 'tool_use',
      model: 'claude-sonnet-4-20250514',
    });
    // Second call: model completes
    mockChat.mockResolvedValueOnce({
      content: 'Based on the search: here is the summary.',
      usage: { inputTokens: 80, outputTokens: 60 },
      finishReason: 'stop',
      model: 'claude-sonnet-4-20250514',
    });

    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: { results: ['relevant chunk'] },
    });

    const result = await executeAgentCall(makeStep(), makeCtx());

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search-knowledge',
      { query: 'test' },
      { userId: 'user_1', agentId: 'agent_1' }
    );
    expect(result.output).toBe('Based on the search: here is the summary.');
    expect(mockChat).toHaveBeenCalledTimes(2);

    // Second call should include tool result in messages
    const secondCallMessages = mockChat.mock.calls[1][0];
    const toolMessage = secondCallMessages.find((m: { role: string }) => m.role === 'tool');
    // Assert specific value directly — avoids a misleading TypeError if find() returns undefined
    expect(toolMessage?.toolCallId).toBe('tc_1');
  });

  it('tool with skipFollowup returns tool result as output', async () => {
    mockChat.mockResolvedValueOnce({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'get-cost', arguments: {} }],
      usage: { inputTokens: 30, outputTokens: 10 },
      finishReason: 'tool_use',
      model: 'claude-sonnet-4-20250514',
    });

    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: { estimatedCost: 0.05 },
      skipFollowup: true,
    });

    const result = await executeAgentCall(makeStep(), makeCtx());

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(result.output).toBe(JSON.stringify({ estimatedCost: 0.05 }));
  });

  it('accumulates cost across multiple tool loop turns', async () => {
    vi.mocked(calculateCost)
      .mockReturnValueOnce({
        totalCostUsd: 0.01,
        isLocal: false,
        inputCostUsd: 0.004,
        outputCostUsd: 0.006,
      })
      .mockReturnValueOnce({
        totalCostUsd: 0.02,
        isLocal: false,
        inputCostUsd: 0.008,
        outputCostUsd: 0.012,
      });

    mockChat.mockResolvedValueOnce({
      content: 'searching...',
      toolCalls: [{ id: 'tc_1', name: 'search', arguments: {} }],
      usage: { inputTokens: 50, outputTokens: 30 },
      finishReason: 'tool_use',
      model: 'claude-sonnet-4-20250514',
    });
    mockChat.mockResolvedValueOnce({
      content: 'Done.',
      usage: { inputTokens: 100, outputTokens: 60 },
      finishReason: 'stop',
      model: 'claude-sonnet-4-20250514',
    });

    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const result = await executeAgentCall(makeStep(), makeCtx());

    expect(result.tokensUsed).toBe(240); // 80 + 160
    expect(result.costUsd).toBe(0.03); // 0.01 + 0.02
  });

  it('respects maxToolIterations config', async () => {
    // Always return a tool call — should stop after 2 iterations
    mockChat.mockResolvedValue({
      content: 'looping...',
      toolCalls: [{ id: 'tc_1', name: 'search', arguments: {} }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'tool_use',
      model: 'claude-sonnet-4-20250514',
    });

    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const step = makeStep({ maxToolIterations: 2 });
    const result = await executeAgentCall(step, makeCtx());

    // Should have called chat exactly 2 times (the loop cap)
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(result.output).toBe('looping...');
  });

  it('includes tool definitions when agent has capabilities', async () => {
    vi.mocked(getCapabilityDefinitions).mockResolvedValue([
      {
        name: 'search-knowledge',
        description: 'Search the knowledge base',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]);

    await executeAgentCall(makeStep(), makeCtx());

    const options = mockChat.mock.calls[0][1];
    expect(options.tools).toHaveLength(1);
    expect(options.tools[0].name).toBe('search-knowledge');
  });

  it('omits system message when agent has no systemInstructions', async () => {
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      ...MOCK_AGENT,
      systemInstructions: null,
    } as never);

    await executeAgentCall(makeStep(), makeCtx());

    const messages = mockChat.mock.calls[0][0];
    expect(messages[0].role).toBe('user');
    expect(messages).toHaveLength(1);
  });

  it('logs cost for each LLM turn', async () => {
    await executeAgentCall(makeStep(), makeCtx());

    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_1',
        workflowExecutionId: 'exec_1',
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        operation: 'chat',
        metadata: { stepId: 'step1', iteration: 0 },
      })
    );
  });

  // ── agent_call_depth_exceeded ─────────────────────────────────────────────

  it('throws agent_call_depth_exceeded when depth >= MAX_AGENT_CALL_DEPTH (3)', async () => {
    // Arrange: depth is already at the maximum
    const ctx = makeCtx({ variables: { agentCallDepth: 3 } });
    // Act / Assert
    await expect(executeAgentCall(makeStep(), ctx)).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'agent_call_depth_exceeded',
      retriable: false,
    });
    // Agent should not even be loaded
    expect(prisma.aiAgent.findFirst).not.toHaveBeenCalled();
  });

  it('does NOT throw when depth is 2 (below maximum)', async () => {
    // Arrange: depth 2 is below the hard cap of 3
    const ctx = makeCtx({ variables: { agentCallDepth: 2 } });
    // Act / Assert: should proceed normally
    const result = await executeAgentCall(makeStep(), ctx);
    expect(result.output).toBe('Summary result');
  });

  // ── null temperature / maxTokens passthrough ──────────────────────────────

  it('omits temperature from chat options when agent temperature is null', async () => {
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      ...MOCK_AGENT,
      temperature: null,
    } as never);

    await executeAgentCall(makeStep(), makeCtx());

    const options = mockChat.mock.calls[0][1];
    expect(options).not.toHaveProperty('temperature');
  });

  it('omits maxTokens from chat options when agent maxTokens is null', async () => {
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      ...MOCK_AGENT,
      maxTokens: null,
    } as never);

    await executeAgentCall(makeStep(), makeCtx());

    const options = mockChat.mock.calls[0][1];
    expect(options).not.toHaveProperty('maxTokens');
  });

  // ── multi-turn mode ──────────────────────────────────────────────────────

  it('multi-turn: returns structured output with response, turns, and history', async () => {
    // Arrange: single turn, no follow-up question in response
    mockChat.mockResolvedValue({
      content: 'Analysis complete.',
      usage: { inputTokens: 50, outputTokens: 30 },
      finishReason: 'stop',
      model: 'claude-sonnet-4-20250514',
    });

    const step = makeStep({ mode: 'multi-turn', maxTurns: 2 });
    // Act
    const result = await executeAgentCall(step, makeCtx());

    // Assert: output is the structured multi-turn object
    expect(typeof result.output).toBe('object');
    const output = result.output as { response: string; turns: number; history: unknown[] };
    expect(output.response).toBe('Analysis complete.');
    expect(output.turns).toBeGreaterThan(0);
    expect(Array.isArray(output.history)).toBe(true);
  });

  it('multi-turn: continues for another turn when response ends with a question', async () => {
    // Arrange: first response ends with '?', second does not
    mockChat
      .mockResolvedValueOnce({
        content: 'Could you provide more context?',
        usage: { inputTokens: 40, outputTokens: 20 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      })
      .mockResolvedValueOnce({
        content: 'Based on the context, here is the analysis.',
        usage: { inputTokens: 60, outputTokens: 40 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      });

    const step = makeStep({ mode: 'multi-turn', maxTurns: 2 });
    const ctx = makeCtx({ stepOutputs: { step0: 'some prior output' } });
    // Act
    const result = await executeAgentCall(step, ctx);

    // Assert: two turns were run (chat called twice per turn)
    expect(mockChat.mock.calls.length).toBeGreaterThanOrEqual(2);
    const output = result.output as { response: string; turns: number };
    expect(output.turns).toBeGreaterThan(1);
    expect(output.response).toBe('Based on the context, here is the analysis.');
  });

  it('multi-turn: stops at maxTurns even if responses keep asking questions', async () => {
    // Arrange: always returns a question
    mockChat.mockResolvedValue({
      content: 'Can you clarify what you mean?',
      usage: { inputTokens: 30, outputTokens: 15 },
      finishReason: 'stop',
      model: 'claude-sonnet-4-20250514',
    });

    const step = makeStep({ mode: 'multi-turn', maxTurns: 2 });
    // Act
    const result = await executeAgentCall(step, makeCtx());

    const output = result.output as { turns: number };
    // maxTurns: 2: turn 0 appends assistant + followup user; turn 1 appends assistant.
    // history = [user(initial), assistant, user(followup), assistant] = 4 entries
    expect(output.turns).toBe(4);
  });

  it('multi-turn: accumulates tokens and cost across turns', async () => {
    vi.mocked(calculateCost)
      .mockReturnValueOnce({
        totalCostUsd: 0.01,
        isLocal: false,
        inputCostUsd: 0.004,
        outputCostUsd: 0.006,
      })
      .mockReturnValueOnce({
        totalCostUsd: 0.02,
        isLocal: false,
        inputCostUsd: 0.008,
        outputCostUsd: 0.012,
      });

    mockChat
      .mockResolvedValueOnce({
        content: 'Could you clarify?',
        usage: { inputTokens: 50, outputTokens: 20 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      })
      .mockResolvedValueOnce({
        content: 'Thank you for clarifying.',
        usage: { inputTokens: 80, outputTokens: 30 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      });

    const step = makeStep({ mode: 'multi-turn', maxTurns: 2 });
    const ctx = makeCtx({ stepOutputs: { s: 'context' } });
    const result = await executeAgentCall(step, ctx);

    // Tokens from both chat calls should be summed
    expect(result.tokensUsed).toBe(180); // (50+20) + (80+30)
    expect(result.costUsd).toBe(0.03); // 0.01 + 0.02
  });

  // ── OTEL span emission per iteration ──────────────────────────────────────

  describe('OTEL span emission per iteration', () => {
    // Finding 6: Phase 2 wraps the per-iteration body in withSpan(SPAN_AGENT_CALL_TURN).
    // These tests verify the sentinel mechanism — the span count per iteration.

    const tracer = new MockTracer();

    beforeEach(() => {
      tracer.reset();
      registerTracer(tracer);
    });

    afterEach(() => {
      resetTracer();
    });

    it('1-turn no-tool response emits exactly 1 SPAN_AGENT_CALL_TURN span', async () => {
      // Arrange: single response with no tool calls — loop runs once and breaks
      mockChat.mockResolvedValue({
        content: 'Done.',
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      });

      // Act
      await executeAgentCall(makeStep(), makeCtx());

      // Assert: exactly one turn span was emitted
      const turnSpans = tracer.spans.filter((s) => s.name === SPAN_AGENT_CALL_TURN);
      expect(turnSpans).toHaveLength(1);
    });

    it('2-turn tool-then-final response emits exactly 2 SPAN_AGENT_CALL_TURN spans', async () => {
      // Arrange: first call requests a tool, second completes
      mockChat
        .mockResolvedValueOnce({
          content: 'Thinking...',
          toolCalls: [{ id: 'tc_1', name: 'search', arguments: { q: 'x' } }],
          usage: { inputTokens: 50, outputTokens: 20 },
          finishReason: 'tool_use',
          model: 'claude-sonnet-4-20250514',
        })
        .mockResolvedValueOnce({
          content: 'Done.',
          usage: { inputTokens: 80, outputTokens: 40 },
          finishReason: 'stop',
          model: 'claude-sonnet-4-20250514',
        });

      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: { result: 'found' },
      });

      // Act
      await executeAgentCall(makeStep(), makeCtx());

      // Assert: two turn spans — one per iteration
      const turnSpans = tracer.spans.filter((s) => s.name === SPAN_AGENT_CALL_TURN);
      expect(turnSpans).toHaveLength(2);
    });

    it('1-turn skipFollowup=true capability result emits exactly 1 SPAN_AGENT_CALL_TURN span', async () => {
      // Arrange: model calls a tool whose result has skipFollowup=true — loop breaks after first turn
      mockChat.mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'get-cost', arguments: {} }],
        usage: { inputTokens: 30, outputTokens: 10 },
        finishReason: 'tool_use',
        model: 'claude-sonnet-4-20250514',
      });

      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: { cost: 0.05 },
        skipFollowup: true, // sentinel: break without a second LLM turn
      });

      // Act
      await executeAgentCall(makeStep(), makeCtx());

      // Assert: only one span — skipFollowup caused 'break' before a second iteration
      const turnSpans = tracer.spans.filter((s) => s.name === SPAN_AGENT_CALL_TURN);
      expect(turnSpans).toHaveLength(1);
    });
  });

  it('multi-turn: outer-loop accumulator survives an inner-turn failure', async () => {
    // Outer turn 1 succeeds with a follow-up question (50+20 tokens, $0.01).
    // Outer turn 2's runSingleTurn throws on provider.chat. The thrown
    // ExecutorError must carry turn-1's partial cost on top of turn 2's
    // own partial — otherwise the row total would only show turn 2.
    mockChat
      .mockResolvedValueOnce({
        content: 'Could you provide more context?',
        usage: { inputTokens: 50, outputTokens: 20 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      })
      .mockRejectedValueOnce(new Error('Provider 503'));

    const step = makeStep({ mode: 'multi-turn', maxTurns: 2 });
    const ctx = makeCtx({ stepOutputs: { prior: 'value' } });

    await expect(executeAgentCall(step, ctx)).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'agent_call_failed',
      // turn 1 billed 70 tokens / $0.01 (default calculateCost). Turn 2 threw
      // before any successful chat() returned, so its partial is 0.
      tokensUsed: 70,
      costUsd: 0.01,
    });
  });

  // ── Multi-turn checkpoint resume ─────────────────────────────────────────

  describe('multi-turn checkpoint resume', () => {
    // Nested beforeEach resets the LLM provider mock so each resume test
    // gets a clean call-count slate (gotcha #22 — module-mock defaults leak
    // across describe blocks when only vi.clearAllMocks() is in scope).
    beforeEach(() => {
      vi.mocked(mockChat).mockReset();
      // Re-apply a default resolved value so tests that don't set their own
      // still get a sensible LLM response.
      vi.mocked(mockChat).mockResolvedValue({
        content: 'Summary result',
        usage: { inputTokens: 100, outputTokens: 50 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      });
      // Re-apply dispatcher default (no toolCalls path)
      vi.mocked(capabilityDispatcher.dispatch).mockReset();
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: {},
      });
    });

    // ── Test 1: Single-turn fresh start with ctx.recordTurn set ────────────

    it('single-turn fresh start (no resumeTurns): recordTurn called with final-answer shape', async () => {
      // Arrange: single-turn mode, provider returns final answer (no tool calls).
      const recordTurn = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({ recordTurn });
      const step = makeStep({ mode: 'single-turn' });

      // Act
      const result = await executeAgentCall(step, ctx);

      // Assert: one recordTurn call with the final-answer shape (no toolCall field)
      expect(result.output).toBe('Summary result');
      expect(recordTurn).toHaveBeenCalledTimes(1);
      expect(recordTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'agent_call',
          phase: 'terminal',
          index: 0,
          assistantContent: 'Summary result',
          tokensUsed: 150,
          costUsd: 0.01,
        })
      );
      // Final-answer shape: phase 'terminal' AND no toolCall field — both
      // signal end-of-step to resume logic; assert both for defence in depth.
      expect(recordTurn.mock.calls[0][0]).not.toHaveProperty('toolCall');
    });

    // ── Test 2: Single-turn fresh start, NO ctx.recordTurn ─────────────────

    it('single-turn fresh start (no resumeTurns, no ctx.recordTurn): completes without crashing', async () => {
      // Arrange: ctx without recordTurn — the separate sentinel fn must never fire
      const sentinelFn = vi.fn();
      const ctx = makeCtx(); // no recordTurn property
      const step = makeStep({ mode: 'single-turn' });

      // Act
      const result = await executeAgentCall(step, ctx);

      // Assert: run completed successfully, sentinel was never called
      expect(result.output).toBe('Summary result');
      expect(sentinelFn).not.toHaveBeenCalled();
    });

    // ── Test 3: Resume with prior turns (last has toolCall) → rebuild ───────

    it('single-turn resume: lastPrior has toolCall → rebuilds conversation and continues', async () => {
      // Arrange: three prior iterations, each with a toolCall (not finalized)
      const priorTurns = [
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 0,
          assistantContent: 'a0',
          toolCall: { id: 't0', name: 'cap', arguments: {} },
          toolResult: { x: 1 },
          tokensUsed: 50,
          costUsd: 0.005,
        },
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 1,
          assistantContent: 'a1',
          toolCall: { id: 't1', name: 'cap', arguments: {} },
          toolResult: { x: 2 },
          tokensUsed: 60,
          costUsd: 0.006,
        },
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 2,
          assistantContent: 'a2',
          toolCall: { id: 't2', name: 'cap', arguments: {} },
          toolResult: { x: 3 },
          tokensUsed: 70,
          costUsd: 0.007,
        },
      ];

      // Mock provider to return a final (no-tool) answer on the resumed call
      vi.mocked(mockChat).mockResolvedValueOnce({
        content: 'Final answer after resume',
        usage: { inputTokens: 40, outputTokens: 20 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      });
      vi.mocked(calculateCost).mockReturnValueOnce({
        totalCostUsd: 0.003,
        isLocal: false,
        inputCostUsd: 0.001,
        outputCostUsd: 0.002,
      });

      const ctx = makeCtx({ resumeTurns: priorTurns });
      const step = makeStep({ mode: 'single-turn' });

      // Act
      const result = await executeAgentCall(step, ctx);

      // Assert: provider.chat called exactly once (one new iteration after rebuild)
      expect(mockChat).toHaveBeenCalledTimes(1);

      // Tokens accumulate: sum of prior turns + the resumed iteration's tokens
      // (inputTokens: 40 + outputTokens: 20 = 60 from the mockResolvedValueOnce above)
      const priorTokensTotal = priorTurns.reduce((s, t) => s + t.tokensUsed, 0); // 50+60+70=180
      const resumedIterationTokens = 40 + 20; // matches mockResolvedValueOnce usage
      expect(result.tokensUsed).toBe(priorTokensTotal + resumedIterationTokens);

      // logger.info fired with the resume message
      const { logger } = await import('@/lib/logging');
      expect(logger.info).toHaveBeenCalledWith(
        'agent_call: resuming single-turn from prior iterations',
        expect.objectContaining({ stepId: 'step1' })
      );
    });

    // ── Test 4: Resume short-circuit (lastPrior has NO toolCall) ───────────

    it('single-turn resume short-circuit: lastPrior has no toolCall → returns cached result, no LLM call', async () => {
      // Arrange: prior turns ending with a terminal entry (phase: 'terminal')
      const priorTurns = [
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 0,
          assistantContent: 'a0',
          toolCall: { id: 't0', name: 'cap', arguments: {} },
          toolResult: { x: 1 },
          tokensUsed: 50,
          costUsd: 0.005,
        },
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 1,
          assistantContent: 'a1',
          toolCall: { id: 't1', name: 'cap', arguments: {} },
          toolResult: { x: 2 },
          tokensUsed: 60,
          costUsd: 0.006,
        },
        // Final entry: phase 'terminal' → short-circuit on resume
        {
          kind: 'agent_call' as const,
          phase: 'terminal' as const,
          index: 2,
          assistantContent: 'final',
          tokensUsed: 70,
          costUsd: 0.007,
        },
      ];

      const ctx = makeCtx({ resumeTurns: priorTurns });
      const step = makeStep({ mode: 'single-turn' });

      // Act
      const result = await executeAgentCall(step, ctx);

      // Assert: NO LLM call fired (gotcha #23 — prefer not.toHaveBeenCalled)
      expect(mockChat).not.toHaveBeenCalled();

      // Output is the last prior's assistantContent
      expect(result.output).toBe('final');
      // Tokens/cost = sum of all priors — derived from fixture to stay in sync
      const priorTokensTotal = priorTurns.reduce((s, t) => s + t.tokensUsed, 0);
      const priorCostTotal = priorTurns.reduce((s, t) => s + t.costUsd, 0);
      expect(result.tokensUsed).toBe(priorTokensTotal);
      expect(result.costUsd).toBeCloseTo(priorCostTotal);

      // logger.info fired with the short-circuit message
      const { logger } = await import('@/lib/logging');
      expect(logger.info).toHaveBeenCalledWith(
        'agent_call: resume short-circuit — prior attempt already finalized',
        expect.objectContaining({ stepId: 'step1' })
      );
    });

    // ── Test 4b: discriminator pin — phase, not toolCall-absence ───────────

    it('single-turn resume short-circuit narrows on phase=terminal even when stray toolCall is present (pins discriminator)', async () => {
      // Arrange — contrived fixture: phase 'terminal' AND a toolCall present.
      // This is type-illegal under AgentCallTurn, but a row written before
      // the discriminator split (or hand-edited) could produce it. The
      // executor MUST narrow on `phase === 'terminal'`, NOT on `!toolCall`.
      //
      // Anti-green-bar role: a regression to the old `if (!lastPrior.toolCall)`
      // discriminator would FAIL to short-circuit here (toolCall is truthy)
      // and would call the LLM. This test catches that regression even
      // though the visible behaviour (short-circuit on a terminal turn) is
      // unchanged. Every other resume-short-circuit test uses fixtures where
      // phase=terminal AND toolCall is absent — those don't distinguish
      // which discriminator the executor uses.
      //
      // The cast is necessary because TS rejects the contrived shape; that's
      // the type system doing its job. We bypass it once, deliberately, to
      // exercise the runtime check that backs the type-layer guarantee.
      const contrived = {
        kind: 'agent_call' as const,
        phase: 'terminal' as const,
        index: 0,
        assistantContent: 'cached final answer',
        toolCall: { id: 'stray', name: 'cap', arguments: {} },
        tokensUsed: 50,
        costUsd: 0.005,
      } as unknown as TurnEntry;

      const ctx = makeCtx({ resumeTurns: [contrived] });
      const step = makeStep({ mode: 'single-turn' });

      // Act
      const result = await executeAgentCall(step, ctx);

      // Assert — short-circuit fired despite the stray toolCall: NO LLM call.
      // Under the old `!lastPrior.toolCall` check the executor would have
      // continued to runSingleTurn (mockChat would have been called).
      expect(mockChat).not.toHaveBeenCalled();
      expect(result.output).toBe('cached final answer');
      // Tokens/cost reflect only the cached prior — proves we returned the
      // cached result rather than running a new iteration.
      expect(result.tokensUsed).toBe(50);
      expect(result.costUsd).toBeCloseTo(0.005);
    });

    // ── Test 5: outerTurn-tagged entries excluded from single-turn resume ───

    it('single-turn resume filter: outerTurn-tagged entries excluded → treated as fresh start', async () => {
      // Arrange: priorTurns contains only a multi-turn entry (outerTurn set)
      const priorTurns = [
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 0,
          outerTurn: 0,
          assistantContent: 'mt_a0',
          toolCall: { id: 'mt_t0', name: 'cap', arguments: {} },
          toolResult: { x: 1 },
          tokensUsed: 50,
          costUsd: 0.005,
        },
      ];

      const { logger } = await import('@/lib/logging');
      vi.mocked(logger.info).mockClear();

      const ctx = makeCtx({ resumeTurns: priorTurns });
      const step = makeStep({ mode: 'single-turn' });

      // Act: fresh start — no single-turn prior entries found after filter
      await executeAgentCall(step, ctx);

      // Assert: resume logger.info messages were NOT fired (fresh start path)
      const resumeCalls = vi
        .mocked(logger.info)
        .mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].startsWith('agent_call: resume')
        );
      expect(resumeCalls).toHaveLength(0);
    });

    // ── Test 6: non-agent_call kinds excluded from single-turn resume ───────

    it('single-turn resume filter: non-agent_call kind entries excluded → treated as fresh start', async () => {
      // Arrange: priorTurns contains only a reflect turn (different kind)
      const priorTurns = [
        {
          kind: 'reflect' as const,
          iteration: 0,
          draft: 'r',
          converged: false,
          tokensUsed: 99,
          costUsd: 0.099,
        },
      ];

      const ctx = makeCtx({ resumeTurns: priorTurns });
      const step = makeStep({ mode: 'single-turn' });

      // Act: fresh start
      await executeAgentCall(step, ctx);

      // Assert: provider.chat IS called (no short-circuit)
      expect(mockChat).toHaveBeenCalledTimes(1);

      // Tokens do NOT include the reflect turn's 99 tokens
      // (default mock returns inputTokens: 100, outputTokens: 50 = 150 total)
      const result2 = await executeAgentCall(step, makeCtx({ resumeTurns: priorTurns }));
      expect(result2.tokensUsed).toBe(150); // only from the single new LLM call, not 99+150
    });

    // ── Test 7: Multi-turn mode: recordTurn NEVER called ───────────────────

    it('multi-turn mode: recordTurn never called even when ctx.recordTurn is defined', async () => {
      // Arrange: configure for multi-turn mode with 1 turn, non-question response
      const recordTurn = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({ recordTurn });
      const step = makeStep({ mode: 'multi-turn', maxTurns: 1 });

      // Act
      await executeAgentCall(step, ctx);

      // Assert: the executor deliberately does NOT pass recordTurn to runSingleTurn
      // in multi-turn mode — so recordTurn must never fire
      expect(recordTurn).not.toHaveBeenCalled();
    });

    // ── Test 8: recordTurn shape (continuing tool-iteration) ───────────────

    it('recordTurn shape (continuing tool-iteration): includes toolCall and toolResult', async () => {
      // Arrange: two iterations — first calls a tool, second gives final answer
      vi.mocked(mockChat)
        .mockResolvedValueOnce({
          content: 'thinking',
          toolCalls: [{ id: 'c1', name: 'cap', arguments: { q: 'x' } }],
          usage: { inputTokens: 40, outputTokens: 20 },
          finishReason: 'tool_use',
          model: 'claude-sonnet-4-20250514',
        })
        .mockResolvedValueOnce({
          content: 'final',
          usage: { inputTokens: 30, outputTokens: 15 },
          finishReason: 'stop',
          model: 'claude-sonnet-4-20250514',
        });

      const capResult = { success: true, data: { found: 'result' } };
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValueOnce(capResult);

      vi.mocked(calculateCost)
        .mockReturnValueOnce({
          totalCostUsd: 0.002,
          isLocal: false,
          inputCostUsd: 0.001,
          outputCostUsd: 0.001,
        })
        .mockReturnValueOnce({
          totalCostUsd: 0.0015,
          isLocal: false,
          inputCostUsd: 0.0007,
          outputCostUsd: 0.0008,
        });

      const recordTurn = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({ recordTurn });
      const step = makeStep({ mode: 'single-turn' });

      // Act
      await executeAgentCall(step, ctx);

      // Assert: first recordTurn call = continuing tool-iteration shape
      expect(recordTurn).toHaveBeenCalledTimes(2);
      const firstCall = recordTurn.mock.calls[0][0] as Record<string, unknown>;
      expect(firstCall).toMatchObject({
        kind: 'agent_call',
        phase: 'continuing',
        index: 0,
        assistantContent: 'thinking',
        toolCall: { id: 'c1', name: 'cap', arguments: { q: 'x' } },
        toolResult: capResult,
        tokensUsed: 60, // 40 + 20
        costUsd: 0.002,
      });
    });

    // ── Test 9: recordTurn shape (final no-tool-call answer) ───────────────

    it('recordTurn shape (final no-tool-call): no toolCall field present', async () => {
      // Arrange: single iteration, no tool calls returned
      const recordTurn = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({ recordTurn });
      const step = makeStep({ mode: 'single-turn' });

      // Act: default mockChat returns no toolCalls
      await executeAgentCall(step, ctx);

      // Assert: one recordTurn call with no toolCall field
      expect(recordTurn).toHaveBeenCalledTimes(1);
      const call = recordTurn.mock.calls[0][0];
      expect(call).toMatchObject({
        kind: 'agent_call',
        phase: 'terminal',
        index: 0,
        assistantContent: 'Summary result',
        tokensUsed: 150,
        costUsd: 0.01,
      });
      // Absent-field assertion: no toolCall on terminal-phase turn
      expect(call).not.toHaveProperty('toolCall');
    });

    // ── Test 10: recordTurn shape (skipFollowup termination) ───────────────

    it('recordTurn shape (skipFollowup): synthesized assistantContent, no toolCall field', async () => {
      // Arrange: capability returns skipFollowup=true
      vi.mocked(mockChat).mockResolvedValueOnce({
        content: 'thinking',
        toolCalls: [{ id: 'c1', name: 'cap', arguments: {} }],
        usage: { inputTokens: 30, outputTokens: 10 },
        finishReason: 'tool_use',
        model: 'claude-sonnet-4-20250514',
      });

      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValueOnce({
        success: true,
        data: { result: 'foo' },
        skipFollowup: true,
      });

      vi.mocked(calculateCost).mockReturnValueOnce({
        totalCostUsd: 0.002,
        isLocal: false,
        inputCostUsd: 0.001,
        outputCostUsd: 0.001,
      });

      const recordTurn = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({ recordTurn });
      const step = makeStep({ mode: 'single-turn' });

      // Act
      await executeAgentCall(step, ctx);

      // Assert: recordTurn called once with synthesized content from capResult.data
      expect(recordTurn).toHaveBeenCalledTimes(1);
      const call = recordTurn.mock.calls[0][0];
      expect(call).toMatchObject({
        kind: 'agent_call',
        phase: 'terminal',
        index: 0,
        assistantContent: JSON.stringify({ result: 'foo' }),
        tokensUsed: 40, // 30 + 10
        costUsd: 0.002,
      });
      // skipFollowup entries must NOT carry toolCall (terminal phase)
      expect(call).not.toHaveProperty('toolCall');
    });

    // ── Test 11: Conversation rebuild on resume ─────────────────────────────

    it('conversation rebuild on resume: messages include rebuilt assistant+tool pairs', async () => {
      // Arrange: three prior iterations each with a toolCall
      const priorTurns = [
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 0,
          assistantContent: 'a0',
          toolCall: { id: 't0', name: 'cap', arguments: {} },
          toolResult: { x: 1 },
          tokensUsed: 50,
          costUsd: 0.005,
        },
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 1,
          assistantContent: 'a1',
          toolCall: { id: 't1', name: 'cap', arguments: {} },
          toolResult: { x: 2 },
          tokensUsed: 60,
          costUsd: 0.006,
        },
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 2,
          assistantContent: 'a2',
          toolCall: { id: 't2', name: 'cap', arguments: {} },
          toolResult: { x: 3 },
          tokensUsed: 70,
          costUsd: 0.007,
        },
      ];

      // Mock final answer on the resumed call
      vi.mocked(mockChat).mockResolvedValueOnce({
        content: 'Final',
        usage: { inputTokens: 20, outputTokens: 10 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      });

      const ctx = makeCtx({ resumeTurns: priorTurns });
      const step = makeStep({ mode: 'single-turn' });

      // Act
      await executeAgentCall(step, ctx);

      // Assert: messages passed to provider.chat include initial messages +
      // 2 messages per prior turn (assistant + tool) = initialMessages.length + 6
      const messages = mockChat.mock.calls[0][0] as Array<{ role: string }>;

      // Initial messages = system + user = 2
      const initialCount = 2;
      expect(messages).toHaveLength(initialCount + 6);

      // Verify rebuilt assistant messages
      expect(messages[initialCount]).toEqual(
        expect.objectContaining({ role: 'assistant', content: 'a0' })
      );
      expect(messages[initialCount + 1]).toEqual(
        expect.objectContaining({ role: 'tool', toolCallId: 't0' })
      );
      expect(messages[initialCount + 2]).toEqual(
        expect.objectContaining({ role: 'assistant', content: 'a1' })
      );
      expect(messages[initialCount + 3]).toEqual(
        expect.objectContaining({ role: 'tool', toolCallId: 't1' })
      );
      expect(messages[initialCount + 4]).toEqual(
        expect.objectContaining({ role: 'assistant', content: 'a2' })
      );
      expect(messages[initialCount + 5]).toEqual(
        expect.objectContaining({ role: 'tool', toolCallId: 't2' })
      );
    });

    // ── Test 12: Resume + maxIterations exhausted ───────────────────────────

    it('resume + maxIterations exhausted: loop exits immediately, no LLM call', async () => {
      // Arrange: priorTurns.length === maxToolIterations AND lastPrior has toolCall
      const maxToolIterations = 3;
      const priorTurns = [
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 0,
          assistantContent: 'a0',
          toolCall: { id: 't0', name: 'cap', arguments: {} },
          toolResult: { x: 1 },
          tokensUsed: 30,
          costUsd: 0.003,
        },
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 1,
          assistantContent: 'a1',
          toolCall: { id: 't1', name: 'cap', arguments: {} },
          toolResult: { x: 2 },
          tokensUsed: 30,
          costUsd: 0.003,
        },
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 2,
          assistantContent: 'a2',
          toolCall: { id: 't2', name: 'cap', arguments: {} },
          toolResult: { x: 3 },
          tokensUsed: 30,
          costUsd: 0.003,
        },
      ];

      const ctx = makeCtx({ resumeTurns: priorTurns });
      // maxToolIterations = 3 → startIteration (3) >= maxIterations (3) → loop doesn't run
      const step = makeStep({ mode: 'single-turn', maxToolIterations });

      // Act
      const result = await executeAgentCall(step, ctx);

      // Assert: no new LLM call (loop body never executes)
      expect(mockChat).not.toHaveBeenCalled();
      // Output = startContent = lastPrior.assistantContent
      expect(result.output).toBe('a2');
    });

    // ── Test 13: Tokens accumulate across resume ────────────────────────────

    it('tokens accumulate across resume: prior + new iteration sums correctly', async () => {
      // Arrange: two prior turns (both with toolCall), one new iteration
      const priorTurns = [
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 0,
          assistantContent: 'a0',
          toolCall: { id: 't0', name: 'cap', arguments: {} },
          toolResult: { x: 1 },
          tokensUsed: 30,
          costUsd: 0.003,
        },
        {
          kind: 'agent_call' as const,
          phase: 'continuing' as const,
          index: 1,
          assistantContent: 'a1',
          toolCall: { id: 't1', name: 'cap', arguments: {} },
          toolResult: { x: 2 },
          tokensUsed: 40,
          costUsd: 0.004,
        },
      ];

      // New iteration: 15 input + 10 output = 25 tokens, $0.0025
      vi.mocked(mockChat).mockResolvedValueOnce({
        content: 'Done after resume',
        usage: { inputTokens: 15, outputTokens: 10 },
        finishReason: 'stop',
        model: 'claude-sonnet-4-20250514',
      });
      vi.mocked(calculateCost).mockReturnValueOnce({
        totalCostUsd: 0.0025,
        isLocal: false,
        inputCostUsd: 0.001,
        outputCostUsd: 0.0015,
      });

      const ctx = makeCtx({ resumeTurns: priorTurns });
      const step = makeStep({ mode: 'single-turn' });

      // Act
      const result = await executeAgentCall(step, ctx);

      // Derive expected totals from fixtures so assertion stays in sync if fixture values change
      const priorTokensTotal = priorTurns.reduce((s, t) => s + t.tokensUsed, 0); // 30+40=70
      const newIterationTokens = 15 + 10; // matches mockResolvedValueOnce usage above (inputTokens: 15 + outputTokens: 10)
      const priorCostTotal = priorTurns.reduce((s, t) => s + t.costUsd, 0); // 0.003+0.004=0.007
      const newIterationCost = 0.0025; // matches mockReturnValueOnce totalCostUsd above
      expect(result.tokensUsed).toBe(priorTokensTotal + newIterationTokens);
      expect(result.costUsd).toBeCloseTo(priorCostTotal + newIterationCost);
    });
  });
});
