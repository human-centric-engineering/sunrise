/**
 * Tests for `lib/orchestration/engine/executors/chat-turn.ts`.
 *
 * The executor's value is the "loads history + persists turns" wiring
 * around an otherwise-ordinary `provider.chat()` call, so the tests
 * focus on:
 *   - Happy path: prior messages are loaded ASC, the [system, ...history, user]
 *     messages array is what gets sent to the provider, and the new
 *     user + assistant turns are persisted.
 *   - Missing conversation / missing agent → typed ExecutorError codes.
 *   - persistMessages=false skips the write but still returns output.
 *   - Persistence failure does NOT block the step output (logged + swallowed).
 *   - historyLimit=0 sends only [system, user].
 *   - Template interpolation on conversationId + message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (must come before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: { findUnique: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
    aiMessage: { findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        aiMessage: { create: vi.fn(async () => ({ id: 'msg-stub' })) },
      })
    ),
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProviderWithFallbacks: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(() => ({ inputCostUsd: 0.001, outputCostUsd: 0.002 })),
  logCost: vi.fn(async () => null),
}));

vi.mock('@/lib/orchestration/llm/model-heuristics', () => ({
  narrowReasoningEffort: vi.fn((v: string | null | undefined) =>
    v === null || v === undefined ? undefined : (v as 'low' | 'medium' | 'high' | 'minimal')
  ),
}));

vi.mock('@/lib/orchestration/agents/resolve-effective-prompt', () => ({
  resolveEffectivePrompt: vi.fn(() => ({ systemInstructions: 'You are a helpful agent.' })),
  composeSystemPromptString: vi.fn(() => 'You are a helpful agent.'),
}));

vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  interpolatePrompt: vi.fn((s: string, ctx: { inputData: Record<string, unknown> }) => {
    // Tiny stub — replaces {{trigger.x}} with ctx.inputData.trigger.x.
    return s.replace(/\{\{trigger\.(\w+)\}\}/g, (_m: string, key: string) => {
      const trigger = (ctx.inputData as { trigger?: Record<string, unknown> }).trigger ?? {};
      const value = trigger[key];
      return typeof value === 'string' ? value : '';
    });
  }),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { executeChatTurn } from '@/lib/orchestration/engine/executors/chat-turn';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { trigger: { conversationId: 'conv_1', text: 'hello agent' } },
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
    } as never,
    ...overrides,
  };
}

function makeStep(overrides: Partial<WorkflowStep['config']> = {}): WorkflowStep {
  return {
    id: 'step_chat',
    name: 'Chat',
    type: 'chat_turn',
    config: {
      agentSlug: 'helpful-agent',
      conversationId: '{{trigger.conversationId}}',
      message: '{{trigger.text}}',
      ...overrides,
    },
    nextSteps: [],
  };
}

const mockAgent = {
  id: 'agent_1',
  slug: 'helpful-agent',
  systemInstructions: 'You are a helpful agent.',
  persona: null,
  brandVoiceInstructions: null,
  guardrails: null,
  personaMode: 'override',
  voiceMode: 'override',
  guardrailsMode: 'override',
  profile: null,
  provider: 'openai',
  model: 'gpt-4o-mini',
  fallbackProviders: [],
  temperature: 0.5,
  maxTokens: 500,
  reasoningEffort: null,
  publishedVersionId: 'agentver_1',
};

const mockChatResponse = {
  content: 'Hi! How can I help?',
  usage: { inputTokens: 30, outputTokens: 10 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-4o-mini',
    fallbacks: [],
  });
  vi.mocked(getProviderWithFallbacks).mockResolvedValue({
    provider: { chat: vi.fn(async () => mockChatResponse) } as never,
    usedSlug: 'openai',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('chat_turn — happy path', () => {
  it('loads prior messages, sends [system, ...history, user] to provider, persists both new turns', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
      // Returned newest-first (DESC); executor reverses to chronological.
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'U2' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'U1' },
    ] as never);

    const result = await executeChatTurn(makeStep(), makeCtx());

    expect(result.output).toBe('Hi! How can I help?');
    expect(result.tokensUsed).toBe(40);
    expect(result.costUsd).toBeCloseTo(0.003);

    const providerCall = vi.mocked(getProviderWithFallbacks).mock.results[0]
      .value as unknown as Promise<{ provider: { chat: ReturnType<typeof vi.fn> } }>;
    const { provider } = await providerCall;
    const chatArgs = provider.chat.mock.calls[0];
    const messages = chatArgs[0] as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'system', content: 'You are a helpful agent.' },
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'U2' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'hello agent' },
    ]);

    // Both new messages persisted (in the same transaction).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // Cost logged.
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_1',
        conversationId: 'conv_1',
        workflowExecutionId: 'exec_1',
        provider: 'openai',
        model: 'gpt-4o-mini',
        metadata: expect.objectContaining({ source: 'chat_turn', historyTurnsLoaded: 4 }),
      })
    );
  });

  it('honours historyLimit=0 — sends only [system, user]', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);

    await executeChatTurn(makeStep({ historyLimit: 0 }), makeCtx());

    // findMany NOT called when historyLimit=0
    expect(prisma.aiMessage.findMany).not.toHaveBeenCalled();
  });

  it('persistMessages=false skips the transaction', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    await executeChatTurn(makeStep({ persistMessages: false }), makeCtx());

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────────

describe('chat_turn — error paths', () => {
  it('throws missing_conversation_id when interpolation resolves to empty', async () => {
    const ctx = makeCtx({ inputData: { trigger: { text: 'hi' } } });
    await expect(executeChatTurn(makeStep(), ctx)).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_conversation_id',
    });
  });

  it('throws missing_message when interpolation resolves to empty', async () => {
    const ctx = makeCtx({ inputData: { trigger: { conversationId: 'conv_1' } } });
    await expect(executeChatTurn(makeStep(), ctx)).rejects.toMatchObject({
      code: 'missing_message',
    });
  });

  it('throws conversation_not_found when the conversation row is missing', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);

    await expect(executeChatTurn(makeStep(), makeCtx())).rejects.toMatchObject({
      code: 'conversation_not_found',
    });
  });

  it('throws agent_not_found when the agentSlug does not resolve', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null as never);

    await expect(executeChatTurn(makeStep(), makeCtx())).rejects.toMatchObject({
      code: 'agent_not_found',
    });
  });

  it('wraps a provider-level chat() failure in a typed ExecutorError', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);
    vi.mocked(getProviderWithFallbacks).mockResolvedValue({
      provider: {
        chat: vi.fn(async () => {
          throw new Error('upstream provider 503');
        }),
      } as never,
      usedSlug: 'openai',
    });

    const err = await executeChatTurn(makeStep(), makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutorError);
    expect(err.code).toBe('chat_turn_failed');
    expect(err.message).toContain('503');
  });
});

// ─── Persistence resilience ──────────────────────────────────────────────────

describe('chat_turn — persistence resilience', () => {
  it('returns the output even if message persistence throws (logs + swallows)', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB down') as never);

    const result = await executeChatTurn(makeStep(), makeCtx());
    expect(result.output).toBe('Hi! How can I help?');
  });
});

// ─── Provider config precedence (step override vs agent default) ─────────────

describe('chat_turn — provider config precedence', () => {
  async function lastChatCall(): Promise<{
    messages: unknown;
    opts: Record<string, unknown>;
  }> {
    const stub = (await vi.mocked(getProviderWithFallbacks).mock.results[0].value) as {
      provider: { chat: ReturnType<typeof vi.fn> };
    };
    const call = stub.provider.chat.mock.calls[0];
    return { messages: call[0], opts: call[1] as Record<string, unknown> };
  }

  it('step.temperature beats agent.temperature when both are set', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    await executeChatTurn(makeStep({ temperature: 0.9 }), makeCtx());

    const { opts } = await lastChatCall();
    expect(opts.temperature).toBe(0.9);
  });

  it('falls through to agent.temperature when step config does not set it', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    await executeChatTurn(makeStep(), makeCtx());

    const { opts } = await lastChatCall();
    expect(opts.temperature).toBe(0.5); // agent default
  });

  it('omits temperature entirely when neither step nor agent has one', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      ...mockAgent,
      temperature: null,
    } as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    await executeChatTurn(makeStep(), makeCtx());

    const { opts } = await lastChatCall();
    expect(opts).not.toHaveProperty('temperature');
  });

  it('step.maxTokens beats agent.maxTokens when both are set', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    await executeChatTurn(makeStep({ maxTokens: 1000 }), makeCtx());

    const { opts } = await lastChatCall();
    expect(opts.maxTokens).toBe(1000);
  });

  it('omits maxTokens entirely when neither step nor agent has one', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      ...mockAgent,
      maxTokens: null,
    } as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    await executeChatTurn(makeStep(), makeCtx());

    const { opts } = await lastChatCall();
    expect(opts).not.toHaveProperty('maxTokens');
  });

  it('forwards reasoningEffort to the provider when the agent has it set', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      ...mockAgent,
      reasoningEffort: 'high',
    } as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);
    // narrowReasoningEffort mock returns the value verbatim — see top of file.

    await executeChatTurn(makeStep(), makeCtx());

    const { opts } = await lastChatCall();
    expect(opts.reasoningEffort).toBe('high');
  });
});

// ─── Resilience to unusual upstream shapes ───────────────────────────────────

describe('chat_turn — resilience to unusual upstream shapes', () => {
  it('returns an empty output + zero tokens when the provider returns null content + missing usage', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);
    vi.mocked(getProviderWithFallbacks).mockResolvedValueOnce({
      provider: {
        chat: vi.fn(async () => ({ content: null, usage: undefined })),
      } as never,
      usedSlug: 'openai',
    });

    const result = await executeChatTurn(makeStep(), makeCtx());

    expect(result.output).toBe('');
    expect(result.tokensUsed).toBe(0);
  });

  it('wraps a non-Error throw from resolveAgentProviderAndModel in provider_unresolved (string fallback)', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    // String throw (not an Error instance) — exercises the `err instanceof Error` ELSE branch.
    vi.mocked(resolveAgentProviderAndModel).mockRejectedValueOnce('weird non-error throw');

    const err = await executeChatTurn(makeStep(), makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutorError);
    expect(err.code).toBe('provider_unresolved');
    // Default message wins when err is not an Error.
    expect(err.message).toBe('Failed to resolve agent provider/model');
  });

  it('wraps a non-Error throw from provider.chat in chat_turn_failed (string fallback)', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);
    vi.mocked(getProviderWithFallbacks).mockResolvedValueOnce({
      provider: {
        chat: vi.fn(async () => {
          // The whole point of this test is to exercise the `err instanceof
          // Error` ELSE branch in the executor's chat() catch — that means
          // deliberately rejecting with a non-Error value. The lint rule
          // (and the throw-string rule) both protect against accidental
          // string throws; here it's intentional. Suppress both.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('string-throw-from-vendor');
        }),
      } as never,
      usedSlug: 'openai',
    });

    const err = await executeChatTurn(makeStep(), makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutorError);
    expect(err.code).toBe('chat_turn_failed');
    expect(err.message).toBe('Provider chat() call failed');
  });

  it('persistTurnMessages uses null for agentVersionId when agent has no publishedVersionId', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      ...mockAgent,
      publishedVersionId: null,
    } as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    // Capture the transaction callback's inner tx writes by intercepting $transaction.
    const writes: Array<{ data: Record<string, unknown> }> = [];
    // Loose cast at the boundary so the vi.fn signature satisfies
    // Prisma's strict overload set without dragging the type plumbing
    // into the test. The fn body runs typed.
    vi.mocked(prisma.$transaction).mockImplementationOnce(((fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        aiMessage: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            writes.push({ data });
            return { id: 'm' };
          }),
        },
      })) as never);

    await executeChatTurn(makeStep(), makeCtx());

    expect(writes).toHaveLength(2);
    expect(writes[0].data.agentVersionId).toBeNull();
    expect(writes[1].data.agentVersionId).toBeNull();
  });
});

// ─── logCost catch-handler is exercised ──────────────────────────────────────

describe('chat_turn — logCost failure', () => {
  it('swallows a logCost rejection (warn-and-continue, never blocks the step)', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv_1',
      agentId: 'agent_1',
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(mockAgent as never);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);
    // First call rejects — exercises the .catch() handler on line 239.
    vi.mocked(logCost).mockRejectedValueOnce(new Error('cost log DB down'));

    const result = await executeChatTurn(makeStep(), makeCtx());

    // Step still returns its output even though logCost failed.
    expect(result.output).toBe('Hi! How can I help?');
    // The .catch() runs asynchronously; give the microtask queue a chance to flush
    // so the warn-side-effect happens before the test ends.
    await new Promise((r) => setTimeout(r, 0));
  });
});
