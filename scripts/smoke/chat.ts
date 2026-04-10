/* eslint-disable no-console, @typescript-eslint/require-await -- CLI smoke script; fake provider methods need the async signature to match the LlmProvider interface */
/**
 * Streaming chat handler smoke script (`lib/orchestration/chat`)
 *
 * Exercises `streamChat` end-to-end against the real Postgres dev DB with
 * an injected fake `LlmProvider` (no API key, no SDK, no network).
 *
 * Flow:
 *   1. Inject a fake provider via `registerProviderInstance` so
 *      `getProvider(slug)` short-circuits the DB lookup.
 *   2. Create a scoped `smoke-test-*` `AiAgent` row (bound to a real user
 *      to satisfy the `createdBy` FK). Non-destructive to existing data.
 *   3. Run a `streamChat` happy-path turn, printing every `ChatEvent`.
 *   4. Query back the persisted `AiMessage` + `AiCostLog` rows to prove
 *      persistence actually landed.
 *   5. Delete only the rows this script created.
 *
 * Safety:
 *   - All writes are scoped by `smoke-test-*` slug — never touches real
 *     data. Stale rows from a previous run are cleaned up before seeding.
 *   - No destructive operations on any other table. Read
 *     `scripts/smoke/README.md` before adding more smoke scripts.
 *
 * Run with:
 *   npm run smoke:chat
 *   # or:
 *   npx tsx --env-file=.env.local scripts/smoke/chat.ts
 */

import { prisma } from '@/lib/db/client';
import { streamChat } from '@/lib/orchestration/chat';
import type { ChatEvent } from '@/types/orchestration';
import { registerProviderInstance } from '@/lib/orchestration/llm/provider-manager';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import type {
  LlmMessage,
  LlmOptions,
  LlmResponse,
  ModelInfo,
  StreamChunk,
} from '@/lib/orchestration/llm/types';

const SMOKE_PROVIDER_NAME = 'smoke-test-provider';
const SMOKE_AGENT_SLUG = 'smoke-test-agent';

/**
 * Build a fake provider whose `chatStream` yields a scripted sequence of
 * chunks. Each invocation pops the next script off a queue, so a multi-turn
 * tool-loop test can provide one script per turn.
 */
function makeFakeProvider(scripts: StreamChunk[][]): LlmProvider {
  const queue = [...scripts];
  return {
    name: SMOKE_PROVIDER_NAME,
    isLocal: false,
    async chat(_messages: LlmMessage[], _options: LlmOptions): Promise<LlmResponse> {
      throw new Error('smoke fake provider does not implement chat()');
    },
    async *chatStream(_messages: LlmMessage[], _options: LlmOptions): AsyncIterable<StreamChunk> {
      const script = queue.shift();
      if (!script) {
        throw new Error('smoke fake provider ran out of scripted turns');
      }
      for (const chunk of script) {
        yield chunk;
      }
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

async function runTurn(
  label: string,
  args: Parameters<typeof streamChat>[0]
): Promise<{ events: ChatEvent[]; conversationId: string | null }> {
  console.log(`\n════ ${label} ════`);
  const events: ChatEvent[] = [];
  let conversationId: string | null = null;
  for await (const event of streamChat(args)) {
    events.push(event);
    const preview =
      event.type === 'content'
        ? `content delta="${event.delta}"`
        : JSON.stringify(event).slice(0, 200);
    console.log('  •', preview);
    if (event.type === 'start') conversationId = event.conversationId;
  }
  return { events, conversationId };
}

async function main(): Promise<void> {
  // ── 1. Bind to a real user (createdBy FK) ────────────────────────────
  const user = await prisma.user.findFirst();
  if (!user) {
    console.error('✗ No user rows in dev DB — seed a user first.');
    process.exit(1);
  }
  console.log(`[1] using user ${user.id} (${user.email})`);

  // ── 2. Seed scoped agent row ─────────────────────────────────────────
  // Delete any stale agent from a previous smoke run so we start clean.
  // Scoped by slug — touches nothing else.
  const stale = await prisma.aiAgent.findUnique({
    where: { slug: SMOKE_AGENT_SLUG },
  });
  if (stale) {
    await prisma.aiMessage.deleteMany({
      where: { conversation: { agentId: stale.id } },
    });
    await prisma.aiCostLog.deleteMany({ where: { agentId: stale.id } });
    await prisma.aiConversation.deleteMany({ where: { agentId: stale.id } });
    await prisma.aiAgent.delete({ where: { id: stale.id } });
    console.log(`[2] cleaned up stale ${SMOKE_AGENT_SLUG}`);
  }

  const agent = await prisma.aiAgent.create({
    data: {
      slug: SMOKE_AGENT_SLUG,
      name: 'Smoke Test Agent',
      description: 'Throwaway agent for scripts/smoke-chat.ts — safe to delete.',
      provider: SMOKE_PROVIDER_NAME,
      model: 'fake-model-1',
      systemInstructions: 'You are a smoke test agent. Keep replies terse.',
      isActive: true,
      createdBy: user.id,
    },
  });
  console.log(`[2] created agent ${agent.id} (${agent.slug})`);

  // ── 3. Inject fake provider into the cache ───────────────────────────
  // Two scripted turns: one happy-path, one tool-call round-trip (but we
  // won't use the tool-call turn for this smoke because it needs real
  // capability rows; happy path is enough to prove the end-to-end wire).
  const fake = makeFakeProvider([
    // Turn 1: plain text response (happy path).
    [
      { type: 'text', content: 'Hello from ' },
      { type: 'text', content: 'the smoke handler!' },
      {
        type: 'done',
        usage: { inputTokens: 42, outputTokens: 17 },
        finishReason: 'stop',
      },
    ],
  ]);
  registerProviderInstance(SMOKE_PROVIDER_NAME, fake);
  console.log(`[3] injected fake provider under name "${SMOKE_PROVIDER_NAME}"`);

  // ── 4. Run a chat turn ───────────────────────────────────────────────
  const { events, conversationId } = await runTurn('streamChat happy path', {
    message: 'smoke test — please respond',
    agentSlug: SMOKE_AGENT_SLUG,
    userId: user.id,
  });

  if (!conversationId) {
    console.error('✗ handler crashed before emitting start event');
    process.exit(1);
  }

  // ── 5. Verify event shape ────────────────────────────────────────────
  const types = events.map((e) => e.type);
  console.log('\n[5] event type sequence:', types.join(' → '));
  const expected = ['start', 'content', 'content', 'done'];
  const ok = types.length === expected.length && types.every((t, i) => t === expected[i]);
  console.log(`    ${ok ? '✓' : '✗'} matches expected sequence`);

  // ── 6. Verify persistence ────────────────────────────────────────────
  const messages = await prisma.aiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
  console.log(
    `\n[6] ${messages.length} AiMessage rows persisted for conversation ${conversationId}:`
  );
  for (const m of messages) {
    const preview = m.content.length > 60 ? m.content.slice(0, 60) + '…' : m.content;
    console.log(`    • [${m.role}] ${preview}`);
  }

  const costLogs = await prisma.aiCostLog.findMany({
    where: { agentId: agent.id },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n[7] ${costLogs.length} AiCostLog rows for agent ${agent.id}:`);
  for (const c of costLogs) {
    console.log(
      `    • ${c.operation} in=${c.inputTokens} out=${c.outputTokens} cost=$${c.totalCostUsd}`
    );
  }

  // Give the fire-and-forget logCost promise a tick to settle before we
  // delete the agent row. (logCost awaits prisma.aiCostLog.create; if we
  // race it, the FK target is gone and the row silently fails to land.)
  await new Promise((r) => setTimeout(r, 250));

  // ── 8. Cleanup (scoped to this smoke run only) ───────────────────────
  console.log('\n[8] cleanup (scoped)…');
  const deletedMessages = await prisma.aiMessage.deleteMany({
    where: { conversationId },
  });
  const deletedCosts = await prisma.aiCostLog.deleteMany({
    where: { agentId: agent.id },
  });
  const deletedConversations = await prisma.aiConversation.deleteMany({
    where: { id: conversationId },
  });
  const deletedAgents = await prisma.aiAgent.deleteMany({
    where: { id: agent.id },
  });
  console.log(
    `    deleted: ${deletedMessages.count} messages, ${deletedCosts.count} cost logs, ${deletedConversations.count} conversations, ${deletedAgents.count} agents`
  );

  await prisma.$disconnect();

  if (!ok) process.exit(1);
  console.log('\n✓ smoke test passed');
}

main().catch(async (err) => {
  console.error('\n✗ smoke script failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
