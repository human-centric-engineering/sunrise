/* eslint-disable @typescript-eslint/require-await -- CLI smoke script; fake provider methods need the async signature to match the LlmProvider interface */
/**
 * Embed visitor smoke script (#705, t-765)
 *
 * Proves, against the real Postgres dev DB, that an anonymous embed-widget
 * visitor can hold a conversation. Every mocked test passed while the first
 * message failed: the handler wrote the visitor id into
 * `AiConversation.userId`, a foreign key to `user`, and a visitor is not a
 * `User`. Only a real database enforces the key.
 *
 * Flow, the way `POST /api/v1/embed/chat/stream` runs a turn: the token
 * resolved by `resolveEmbedToken`, the turn run inside the token's org
 * (`runAsOrg(…, { source: 'embed-token' })`), `streamChat` given the visitor
 * id. All real; only the LLM is faked. (The route itself reads Next's request
 * headers, which exist only inside a running server, and a server would not
 * see this script's fake provider.)
 *   1. Seed a `smoke-embed-*` agent and an embed token in the install org.
 *   2. Visitor A's first message: a reply arrives, and the conversation is
 *      stored with no `userId`, owned through `embedVisitorId`. No `User` row
 *      exists for the visitor, and the turn's cost row lands unattributed.
 *   3. Visitor A continues the same conversation.
 *   4. Visitor B (another IP, same token) cannot continue A's conversation.
 *   5. `write_user_memory` refuses visitor A and stores nothing.
 *   6. Delete only the rows this script created.
 *
 * Run with:
 *   npm run smoke:embed-visitor
 *   # or:
 *   npx tsx --env-file=.env.local scripts/smoke/embed-visitor.ts
 */

import { prisma } from '@/lib/db/client';
import { resolveEmbedToken } from '@/lib/embed/auth';
import { streamChat } from '@/lib/orchestration/chat';
import type { ChatEvent } from '@/types/orchestration';
import { WriteUserMemoryCapability } from '@/lib/orchestration/capabilities/built-in/user-memory';
import { registerProviderInstance } from '@/lib/orchestration/llm/provider-manager';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import type {
  LlmMessage,
  LlmOptions,
  LlmResponse,
  ModelInfo,
  StreamChunk,
} from '@/lib/orchestration/llm/types';
import { runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const SMOKE_PROVIDER_NAME = 'smoke-embed-provider';
const SMOKE_AGENT_SLUG = 'smoke-embed-visitor-agent';
// TEST-NET-3 addresses (RFC 5737): never a real client.
const IP_A = '203.0.113.10';
const IP_B = '203.0.113.11';

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`    ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

/** A provider whose every streamed turn is one short reply. */
function makeFakeProvider(): LlmProvider {
  return {
    name: SMOKE_PROVIDER_NAME,
    isLocal: false,
    async chat(_messages: LlmMessage[], _options: LlmOptions): Promise<LlmResponse> {
      throw new Error('smoke fake provider does not implement chat()');
    },
    async *chatStream(_messages: LlmMessage[], _options: LlmOptions): AsyncIterable<StreamChunk> {
      yield { type: 'text', content: 'Hello, visitor.' };
      yield { type: 'done', usage: { inputTokens: 12, outputTokens: 4 }, finishReason: 'stop' };
    },
    async embed(_text: string): Promise<number[]> {
      throw new Error('smoke fake provider does not implement embed()');
    },
    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
    async testConnection() {
      return { ok: true, models: [] };
    },
  };
}

/** One embed turn, as the stream route runs it, collecting its events. */
async function send(
  token: string,
  ip: string,
  body: { message: string; conversationId?: string }
): Promise<ChatEvent[]> {
  const ctx = await resolveEmbedToken(token, ip);
  if (!ctx) throw new Error('the seeded embed token did not resolve');
  return runAsOrg(
    ctx.orgId,
    async () => {
      const events: ChatEvent[] = [];
      for await (const event of streamChat({
        message: body.message,
        agentSlug: ctx.agentSlug,
        userId: ctx.userId,
        conversationId: body.conversationId,
      })) {
        events.push(event);
      }
      return events;
    },
    { source: 'embed-token' }
  );
}

async function cleanup(agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  await prisma.aiMessage.deleteMany({ where: { conversation: { agentId: { in: agentIds } } } });
  await prisma.aiCostLog.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.aiConversation.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.aiAgentEmbedToken.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.aiAgent.deleteMany({ where: { id: { in: agentIds } } });
}

async function main(): Promise<void> {
  // ── 1. Seed ───────────────────────────────────────────────────────────
  const stale = await prisma.aiAgent.findMany({
    where: { slug: SMOKE_AGENT_SLUG },
    select: { id: true },
  });
  await cleanup(stale.map((a) => a.id));

  const agent = await prisma.aiAgent.create({
    data: {
      slug: SMOKE_AGENT_SLUG,
      name: 'Smoke Embed Visitor Agent',
      description: 'Throwaway agent for scripts/smoke/embed-visitor.ts — safe to delete.',
      provider: SMOKE_PROVIDER_NAME,
      model: 'fake-model-1',
      systemInstructions: 'You are a smoke test agent. Keep replies terse.',
      isActive: true,
    },
  });
  const { token } = await prisma.aiAgentEmbedToken.create({
    data: { agentId: agent.id, label: 'smoke-embed-visitor' },
  });
  registerProviderInstance(SMOKE_PROVIDER_NAME, makeFakeProvider());
  console.log(`[1] seeded agent ${agent.id} and an embed token`);

  try {
    const visitorA = (await resolveEmbedToken(token, IP_A))?.userId;
    const visitorB = (await resolveEmbedToken(token, IP_B))?.userId;
    if (!visitorA || !visitorB) throw new Error('the seeded embed token did not resolve');

    // ── 2. Visitor A's first message ────────────────────────────────────
    console.log('\n[2] visitor A’s first message');
    const first = await send(token, IP_A, { message: 'Hello from the widget' });
    const start = first.find((e) => e.type === 'start');
    const error = first.find((e) => e.type === 'error');
    check(!error, `no error event${error ? ` — got ${JSON.stringify(error)}` : ''}`);
    check(
      first.some((e) => e.type === 'done'),
      'the turn completes with a reply'
    );
    const conversationId = start?.type === 'start' ? start.conversationId : null;
    const conversation = conversationId
      ? await prisma.aiConversation.findUnique({ where: { id: conversationId } })
      : null;
    check(conversation !== null, 'a conversation row exists');
    check(conversation?.userId === null, 'it has no userId');
    check(conversation?.embedVisitorId === visitorA, 'it is owned through embedVisitorId');
    check(conversation?.orgId === INSTALL_ORG_ID, 'it belongs to the token’s org');
    check(
      (await prisma.user.count({ where: { id: visitorA } })) === 0,
      'no User row exists for the visitor'
    );
    const messages = conversationId
      ? await prisma.aiMessage.count({ where: { conversationId } })
      : 0;
    check(messages === 2, `the question and the reply are stored (${messages} messages)`);
    // `logCost` is fire-and-forget; give it a moment to land.
    await new Promise((r) => setTimeout(r, 300));
    const costRows = await prisma.aiCostLog.findMany({
      where: { agentId: agent.id },
      select: { userId: true },
    });
    check(
      costRows.length > 0 && costRows.every((r) => r.userId === null),
      `the turn’s cost is logged, unattributed (${costRows.length} row(s))`
    );

    // ── 3. Visitor A continues ──────────────────────────────────────────
    console.log('\n[3] visitor A continues the conversation');
    const second = conversationId
      ? await send(token, IP_A, { message: 'And again', conversationId })
      : [];
    const secondStart = second.find((e) => e.type === 'start');
    check(
      secondStart?.type === 'start' &&
        secondStart.conversationId === conversationId &&
        second.some((e) => e.type === 'done'),
      'the same conversation continues and replies'
    );

    // ── 4. Visitor B cannot continue A's conversation ───────────────────
    console.log('\n[4] visitor B (another IP) tries A’s conversation');
    const intruder = conversationId
      ? await send(token, IP_B, { message: 'Let me in', conversationId })
      : [];
    check(
      intruder.some((e) => e.type === 'error' && e.code === 'conversation_not_found'),
      'refused as conversation_not_found'
    );
    const afterIntruder = conversationId
      ? await prisma.aiMessage.count({ where: { conversationId } })
      : 0;
    check(afterIntruder === 4, `nothing was added to A’s conversation (${afterIntruder} messages)`);

    // ── 5. Memory refuses a visitor ─────────────────────────────────────
    console.log('\n[5] write_user_memory as visitor A');
    const memory = await new WriteUserMemoryCapability().execute(
      { key: 'smoke', value: 'should not be stored' },
      { userId: visitorA, agentId: agent.id }
    );
    check(memory.error?.code === 'anonymous_visitor', 'refused as anonymous_visitor');
    check(
      (await prisma.aiUserMemory.count({ where: { userId: visitorA } })) === 0,
      'no memory row was written'
    );
  } finally {
    // ── 6. Cleanup ──────────────────────────────────────────────────────
    await cleanup([agent.id]);
    console.log('\n[6] cleaned up the smoke agent, token, conversations and cost rows');
  }

  await prisma.$disconnect();
  if (failures > 0) {
    console.error(`\n✗ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ embed visitor smoke passed');
}

// Seeding runs in the install org; the route enters the token's org itself.
runAsOrg(INSTALL_ORG_ID, main, { source: 'job' }).catch(async (err) => {
  console.error('\n✗ smoke script failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
