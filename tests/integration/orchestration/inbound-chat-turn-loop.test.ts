/**
 * Integration smoke test — full inbound conversation loop.
 *
 * Simulates the experience an operator gets when they deploy the
 * Inbound Conversation Handler template + an inbound trigger. Two
 * webhook arrivals from the same end user, with stateful in-memory
 * Prisma mocks so the SECOND chat_turn actually loads the FIRST
 * turn's persisted messages from `AiMessage` and includes them in the
 * provider call.
 *
 * This is the strongest correctness signal we can produce without
 * spinning up real Postgres + Twilio. It catches regressions in the
 * "chat_turn persists → next inbound's chat_turn loads" loop that
 * unit tests can't catch (because unit tests mock each Prisma call
 * independently — they can't detect a desync between write and read).
 *
 * Boundaries exercised:
 *   - chat_turn loads prior AiMessage rows oldest-first
 *   - chat_turn persists user + assistant turns in one transaction
 *   - The second invocation sees the first invocation's writes
 *   - System prompt + history + new user message are passed to provider in
 *     the exact order [system, ...history(asc), user]
 *
 * Boundaries deliberately NOT exercised:
 *   - The HTTP route handler (covered by route.test.ts)
 *   - The conversation resolver (covered by conversation-resolver.test.ts)
 *   - The send_message_to_channel capability (covered by its own tests)
 *
 * The point of this test is the cross-execution memory loop, which is
 * the load-bearing claim of chat_turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Stateful in-memory Prisma mock ──────────────────────────────────────────

interface InMemoryMessage {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

const messageStore: InMemoryMessage[] = [];
const conversationStore: { id: string; agentId: string }[] = [
  { id: 'conv_inbound_1', agentId: 'agent_chatbot' },
];

// Monotonic tick — `new Date()` between two same-transaction writes
// often collides at millisecond precision, which breaks the DESC sort
// + reverse round-trip in chat_turn. Real Postgres has microsecond-
// precision timestamps + insert-order tiebreakers; here we synthesise
// the same with a counter.
let writeTick = 0;
function nextWriteTime(): Date {
  writeTick += 1;
  return new Date(writeTick);
}

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          conversationStore.find((c) => c.id === where.id) ?? null
      ),
    },
    aiAgent: {
      findUnique: vi.fn(async () => ({
        id: 'agent_chatbot',
        slug: 'inbound-chatbot',
        systemInstructions: 'You answer concisely.',
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
        temperature: 0.4,
        maxTokens: 500,
        reasoningEffort: null,
        publishedVersionId: null,
      })),
    },
    aiMessage: {
      findMany: vi.fn(
        async ({ where, take }: { where: { conversationId: string }; take?: number }) => {
          // Sort DESC by createdAt (newest first), as the real query does, then `take`.
          const all = messageStore
            .filter((m) => m.conversationId === where.conversationId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return typeof take === 'number' ? all.slice(0, take) : all;
        }
      ),
    },
    // Typed loosely-as-`unknown` then cast at the boundary so the vi.fn
    // signature satisfies Prisma's strict `$transaction` overload set
    // without us re-importing all of the Prisma type plumbing into a
    // test helper. The runtime fn body is fully type-safe.
    $transaction: vi.fn((fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        aiMessage: {
          create: vi.fn(async ({ data }: { data: InMemoryMessage }) => {
            messageStore.push({
              conversationId: data.conversationId,
              role: data.role,
              content: data.content,
              createdAt: nextWriteTime(),
            });
            return { id: `msg_${messageStore.length}` };
          }),
        },
      })
    ),
  },
}));

// ─── LLM provider mock — deterministic per-turn responses ───────────────────

const providerCallLog: { messages: Array<{ role: string; content: string }> }[] = [];

const RESPONSES = [
  'Hi! How can I help with your order today?',
  'Sure — your order #42 shipped yesterday.',
];

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProviderWithFallbacks: vi.fn(async () => ({
    provider: {
      chat: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        providerCallLog.push({ messages });
        const turnIndex = providerCallLog.length - 1;
        return {
          content: RESPONSES[turnIndex] ?? 'fallback',
          usage: { inputTokens: 50, outputTokens: 12 },
        };
      }),
    } as never,
    usedSlug: 'openai',
  })),
}));

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(async () => ({
    providerSlug: 'openai',
    model: 'gpt-4o-mini',
    fallbacks: [],
  })),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(() => ({ inputCostUsd: 0.0005, outputCostUsd: 0.001 })),
  logCost: vi.fn(async () => null),
}));

vi.mock('@/lib/orchestration/llm/model-heuristics', () => ({
  narrowReasoningEffort: vi.fn(() => undefined),
}));

vi.mock('@/lib/orchestration/agents/resolve-effective-prompt', () => ({
  resolveEffectivePrompt: vi.fn(() => ({ systemInstructions: 'You answer concisely.' })),
  composeSystemPromptString: vi.fn(() => 'You answer concisely.'),
}));

vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  interpolatePrompt: vi.fn((s: string, ctx: { inputData: Record<string, unknown> }) =>
    s.replace(/\{\{trigger\.(\w+)\}\}/g, (_m: string, key: string) => {
      const trigger = (ctx.inputData as { trigger?: Record<string, unknown> }).trigger ?? {};
      const v = trigger[key];
      return typeof v === 'string' ? v : '';
    })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { executeChatTurn } from '@/lib/orchestration/engine/executors/chat-turn';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

beforeEach(() => {
  messageStore.length = 0;
  providerCallLog.length = 0;
  writeTick = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── The smoke test ──────────────────────────────────────────────────────────

function makeChatTurnStep(): WorkflowStep {
  return {
    id: 'respond_to_inbound',
    name: 'Respond with conversation memory',
    type: 'chat_turn',
    config: {
      agentSlug: 'inbound-chatbot',
      conversationId: '{{trigger.conversationId}}',
      message: '{{trigger.text}}',
      historyLimit: 20,
      persistMessages: true,
    },
    nextSteps: [],
  };
}

function makeCtxFor(inbound: {
  conversationId: string;
  text: string;
  from: string;
}): ExecutionContext {
  return {
    executionId: `exec_${Math.random().toString(36).slice(2, 9)}`,
    workflowId: 'wf_inbound',
    userId: 'system',
    inputData: {
      trigger: {
        text: inbound.text,
        from: inbound.from,
        channel: 'whatsapp_cloud',
        conversationId: inbound.conversationId,
      },
    },
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
  };
}

describe('Inbound chat_turn conversation loop — full memory round-trip', () => {
  it('the second inbound on the same conversation sees the first turn in the provider history', async () => {
    // ─── Inbound 1 ──────────────────────────────────────────────────────────
    // Simulates: user texts "Hi, I need help with my order."
    const result1 = await executeChatTurn(
      makeChatTurnStep(),
      makeCtxFor({
        conversationId: 'conv_inbound_1',
        text: 'Hi, I need help with my order.',
        from: '+447400123456',
      })
    );

    // The chat_turn step returned the canned first response.
    expect(result1.output).toBe('Hi! How can I help with your order today?');

    // The provider was called with [system, user] only — no history yet.
    expect(providerCallLog).toHaveLength(1);
    expect(providerCallLog[0].messages).toEqual([
      { role: 'system', content: 'You answer concisely.' },
      { role: 'user', content: 'Hi, I need help with my order.' },
    ]);

    // The store now has the two persisted turns (user + assistant).
    expect(messageStore).toHaveLength(2);
    expect(messageStore[0]).toMatchObject({
      role: 'user',
      content: 'Hi, I need help with my order.',
    });
    expect(messageStore[1]).toMatchObject({
      role: 'assistant',
      content: 'Hi! How can I help with your order today?',
    });

    // ─── Inbound 2 ──────────────────────────────────────────────────────────
    // The user replies on the same conversation: "Where is order #42?"
    const result2 = await executeChatTurn(
      makeChatTurnStep(),
      makeCtxFor({
        conversationId: 'conv_inbound_1',
        text: 'Where is order #42?',
        from: '+447400123456',
      })
    );

    expect(result2.output).toBe('Sure — your order #42 shipped yesterday.');

    // The provider was called with [system, ...history-from-turn-1, user].
    // This is the load-bearing assertion of the entire test — it proves
    // chat_turn's persistence on turn 1 is visible to chat_turn's history
    // load on turn 2.
    expect(providerCallLog).toHaveLength(2);
    expect(providerCallLog[1].messages).toEqual([
      { role: 'system', content: 'You answer concisely.' },
      { role: 'user', content: 'Hi, I need help with my order.' },
      { role: 'assistant', content: 'Hi! How can I help with your order today?' },
      { role: 'user', content: 'Where is order #42?' },
    ]);

    // The store now carries all four turns.
    expect(messageStore).toHaveLength(4);
    expect(messageStore.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:Hi, I need help with my order.',
      'assistant:Hi! How can I help with your order today?',
      'user:Where is order #42?',
      'assistant:Sure — your order #42 shipped yesterday.',
    ]);
  });

  it('two parallel conversations stay isolated by conversationId', async () => {
    conversationStore.push({ id: 'conv_inbound_2', agentId: 'agent_chatbot' });

    // Conv A — one turn.
    await executeChatTurn(
      makeChatTurnStep(),
      makeCtxFor({ conversationId: 'conv_inbound_1', text: 'A: hi', from: '+44...' })
    );

    // Conv B — one turn.
    await executeChatTurn(
      makeChatTurnStep(),
      makeCtxFor({ conversationId: 'conv_inbound_2', text: 'B: hi', from: '+44...' })
    );

    // Conv A — second turn. It MUST see only Conv A's prior message,
    // not Conv B's.
    await executeChatTurn(
      makeChatTurnStep(),
      makeCtxFor({ conversationId: 'conv_inbound_1', text: 'A: follow-up', from: '+44...' })
    );

    expect(providerCallLog).toHaveLength(3);
    const callA2 = providerCallLog[2].messages;
    expect(callA2).toEqual([
      { role: 'system', content: 'You answer concisely.' },
      { role: 'user', content: 'A: hi' },
      // First response was 'Hi! How can I help with your order today?' from RESPONSES[0]
      { role: 'assistant', content: 'Hi! How can I help with your order today?' },
      { role: 'user', content: 'A: follow-up' },
    ]);

    // No B-conversation content leaked into A's call.
    expect(callA2.some((m) => m.content.startsWith('B:'))).toBe(false);
  });
});
