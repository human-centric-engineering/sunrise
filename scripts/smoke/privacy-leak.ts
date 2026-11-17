/* eslint-disable @typescript-eslint/require-await -- CLI smoke script; fake provider methods need the async signature to match the LlmProvider interface */
/**
 * LLM privacy layer leak smoke (§127, t-992)
 *
 * Runs a full chat turn and a workflow `llm_call` step against the real dev
 * DB, with `privacyMode: pseudonymise`, through fake providers that RECORD
 * every request they are sent. No API key, no network, no cost.
 *
 * What it proves:
 *   1. Chat turn: no seeded identifier (name, email, NI number) appears in
 *      any request the chat provider received, across the tool loop.
 *   2. The reply the user sees is restored: real values, no placeholders.
 *   3. The tool call the model made with placeholders ran with the real
 *      values: `search_knowledge_base` was dispatched with the real name and
 *      email (read back from the persisted tool message).
 *   4. Under `embeddingsPolicy: local_only` with no local embedding model,
 *      that search returns the relayable tool error instead of embedding the
 *      name with a vendor.
 *   5. Workflow `llm_call`: no seeded identifier in the recorded request; the
 *      step's output is restored.
 *   6. With `privacyMode: off`, the same step sends the identifiers as they
 *      are: provider behaviour unchanged.
 *   7. Confidential content (§130 t-1037): with the Personal policy at
 *      `local_only` and mode `off`, a chat turn holding a health disclosure
 *      to a cloud provider is refused before it is sent (the provider
 *      receives nothing), the reader is told why, and the next turn in the
 *      same conversation is answered without the disclosure.
 *   8. With the Personal policy at `warn`, the turn is answered and the user
 *      is told once: the next turn, which resends the disclosure, is not.
 *   9. Routing (§130 t-1038): with the Personal policy at `local_only` and a
 *      REAL local Ollama chat model set as the model for confidential
 *      messages, the same flagged turn is answered by Ollama, the cloud
 *      provider receives nothing, the user is told once that the
 *      conversation moved, and the next turn stays on Ollama. Needs Ollama
 *      on localhost:11434 with the chat model pulled (`OLLAMA_SMOKE_MODEL`,
 *      default `qwen2.5:0.5b`); without them this part says NOT RUN, which is
 *      not a pass.
 *
 * Safety:
 *   - The install's privacy settings are changed for the run and put back in
 *     a `finally`, whatever happens.
 *   - Every row it creates is scoped by `smoke-test-privacy-*` and deleted at
 *     the end. Stale rows from a failed run are removed first.
 *   - The fake workflow provider is registered under the `openai` slug in
 *     THIS process's provider cache only; nothing is written to the DB.
 *
 * Run with:
 *   npm run smoke:privacy
 *   # or:
 *   npx tsx --env-file=.env.local scripts/smoke/privacy-leak.ts
 */

import { prisma } from '@/lib/db/client';
import { streamChat } from '@/lib/orchestration/chat';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import '@/lib/orchestration/engine/executors';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import { registerProviderInstance } from '@/lib/orchestration/llm/provider-manager';
import type {
  LlmMessage,
  LlmOptions,
  LlmResponse,
  ModelInfo,
  StreamChunk,
} from '@/lib/orchestration/llm/types';
import { invalidateOrchestrationSettingsCache } from '@/lib/orchestration/settings';
import { runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import type { ChatEvent, WorkflowDefinition } from '@/types/orchestration';

const PREFIX = 'smoke-test-privacy';
const CHAT_PROVIDER = `${PREFIX}-provider`;
const AGENT_SLUG = `${PREFIX}-agent`;
const WORKFLOW_SLUG = `${PREFIX}-workflow`;
/** A registry model whose provider slug the fake workflow provider stands in for. */
const WORKFLOW_MODEL = 'gpt-4o-mini';
const WORKFLOW_PROVIDER = 'openai';

const NAME = 'Priya Sharma';
const EMAIL = 'priya.sharma@example.com';
const NINO = 'TJ 33 15 36 A';
const SEEDED = [NAME, EMAIL, NINO];

let failures = 0;
/** Parts that could not run: reported as not run, never as passed. */
const notRun: string[] = [];

const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_SMOKE_MODEL ?? 'qwen2.5:0.5b';
const OLLAMA_PROVIDER = `${PREFIX}-ollama`;
function check(ok: boolean, label: string): void {
  console.log(`    ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

/** The placeholder a request gave a type, e.g. `[EMAIL_1]`. */
function placeholder(request: unknown, type: string): string {
  const m = new RegExp(`\\[${type}_\\d+\\]`).exec(JSON.stringify(request));
  if (!m) throw new Error(`the request carried no ${type} placeholder`);
  return m[0];
}

function leaked(requests: unknown): string[] {
  const text = JSON.stringify(requests);
  return SEEDED.filter((v) => text.includes(v));
}

/**
 * The chat provider: turn 1 searches the knowledge base for the person by the
 * placeholders it was sent; turn 2 answers using them.
 */
function chatProvider(received: LlmMessage[][]): LlmProvider {
  return {
    name: CHAT_PROVIDER,
    isLocal: false,
    async chat(): Promise<LlmResponse> {
      throw new Error('the smoke chat provider streams only');
    },
    async *chatStream(messages: LlmMessage[], _options: LlmOptions): AsyncIterable<StreamChunk> {
      received.push(structuredClone(messages));
      const person = placeholder(messages, 'PERSON');
      const email = placeholder(messages, 'EMAIL');
      const done = {
        type: 'done' as const,
        usage: { inputTokens: 10, outputTokens: 10 },
      };
      if (received.length === 1) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'call-1',
            name: 'search_knowledge_base',
            arguments: { query: `${person} ${email}` },
          },
        };
        yield { ...done, finishReason: 'tool_use' };
        return;
      }
      // Split mid-placeholder, as a real stream may.
      const reply = `Thanks ${person}, I have noted ${email}.`;
      const cut = reply.indexOf(email) + 2;
      yield { type: 'text', content: reply.slice(0, cut) };
      yield { type: 'text', content: reply.slice(cut) };
      yield { ...done, finishReason: 'stop' };
    },
    async embed(): Promise<number[]> {
      throw new Error('the smoke chat provider does not embed');
    },
    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
    async testConnection() {
      return { ok: true, models: [] };
    },
  };
}

/** The workflow provider: echoes the person's placeholder back in its answer. */
function workflowProvider(received: LlmMessage[][]): LlmProvider {
  return {
    name: WORKFLOW_PROVIDER,
    isLocal: false,
    async chat(messages: LlmMessage[]): Promise<LlmResponse> {
      received.push(structuredClone(messages));
      const text = JSON.stringify(messages);
      const person = /\[PERSON_\d+\]/.exec(text)?.[0] ?? NAME;
      return {
        content: `Summary: ${person} asked for a callback.`,
        model: WORKFLOW_MODEL,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
    chatStream(): AsyncIterable<StreamChunk> {
      throw new Error('the smoke workflow provider does not stream');
    },
    async embed(): Promise<number[]> {
      throw new Error('the smoke workflow provider does not embed');
    },
    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
    async testConnection() {
      return { ok: true, models: [] };
    },
  };
}

async function setPrivacy(
  privacyMode: string,
  privacyEmbeddingsPolicy: string,
  privacyConfidentialPersonal = 'allow',
  privacyConfidentialCommercial = 'allow'
): Promise<void> {
  await prisma.aiOrchestrationSettings.update({
    where: { slug: 'global' },
    data: {
      privacyMode,
      privacyEmbeddingsPolicy,
      privacyConfidentialPersonal,
      privacyConfidentialCommercial,
    },
  });
  invalidateOrchestrationSettingsCache();
}

const DISCLOSURE = "I've been signed off with depression";

/** A cloud chat provider that answers every call, and records what it was sent. */
function plainChatProvider(received: LlmMessage[][]): LlmProvider {
  return {
    ...chatProvider(received),
    async *chatStream(messages: LlmMessage[]): AsyncIterable<StreamChunk> {
      received.push(structuredClone(messages));
      yield { type: 'text', content: 'Noted.' };
      yield { type: 'done', usage: { inputTokens: 10, outputTokens: 2 }, finishReason: 'stop' };
    },
  };
}

async function confidentialTurns(userId: string): Promise<void> {
  const agent = await prisma.aiAgent.create({
    data: {
      slug: `${AGENT_SLUG}-confidential`,
      name: 'Smoke Privacy Agent (confidential)',
      description: 'Throwaway agent for scripts/smoke/privacy-leak.ts — safe to delete.',
      provider: CHAT_PROVIDER,
      model: 'fake-model-1',
      systemInstructions: 'You are an HR assistant.',
      isActive: true,
      createdBy: userId,
    },
  });
  const received: LlmMessage[][] = [];
  registerProviderInstance(CHAT_PROVIDER, plainChatProvider(received));
  const turn = async (message: string, conversationId?: string) => {
    const events: ChatEvent[] = [];
    for await (const event of streamChat({
      message,
      agentSlug: agent.slug,
      userId,
      ...(conversationId ? { conversationId } : {}),
    })) {
      events.push(event);
    }
    const started = events.find((e) => e.type === 'start');
    return { events, conversationId: started?.type === 'start' ? started.conversationId : null };
  };

  console.log('\n════ chat turn, confidential content under local_only ════');
  await setPrivacy('off', 'allow', 'local_only', 'allow');
  const refused = await turn(`${DISCLOSURE}. How do I tell my manager?`);
  const error = refused.events.find((e) => e.type === 'error');
  console.log(`    provider calls: ${received.length}; error: ${JSON.stringify(error)}`);
  check(received.length === 0, 'a flagged turn to a cloud provider never reached it');
  check(
    error?.type === 'error' && error.code === 'privacy_confidential',
    'the reader is told it was confidential content'
  );
  if (!refused.conversationId) throw new Error('the refused turn never started');
  const after = await turn('What is the holiday policy?', refused.conversationId);
  check(
    !after.events.some((e) => e.type === 'error'),
    'the next turn in the conversation is answered'
  );
  check(
    received.length === 1 && !JSON.stringify(received).includes(DISCLOSURE),
    'and its call no longer carries the disclosure'
  );

  console.log('\n════ chat turn, confidential content under warn ════');
  await setPrivacy('off', 'allow', 'warn', 'allow');
  const warned = await turn(`${DISCLOSURE}. Can you help me plan my return?`);
  const notes = warned.events.filter((e) => e.type === 'warning');
  console.log(`    notes: ${JSON.stringify(notes.map((n) => n.type === 'warning' && n.code))}`);
  check(
    notes.length === 1 && notes[0].type === 'warning' && notes[0].code === 'confidential_personal',
    'the turn is answered, and the user told once'
  );
  if (!warned.conversationId) throw new Error('the warned turn never started');
  const again = await turn('And after that?', warned.conversationId);
  check(
    !again.events.some((e) => e.type === 'warning'),
    'the next turn resends the disclosure and is not told again'
  );
}

/** Whether Ollama answers and has the chat model pulled. */
async function ollamaHasModel(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    const models =
      body !== null && typeof body === 'object' && 'models' in body && Array.isArray(body.models)
        ? (body.models as unknown[])
        : [];
    return models.some(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        'name' in m &&
        (m.name === OLLAMA_MODEL || m.name === `${OLLAMA_MODEL}:latest`)
    );
  } catch {
    return false;
  }
}

async function movedToLocalModel(userId: string): Promise<void> {
  console.log('\n════ chat turn, confidential content moved to a local Ollama model ════');
  if (!(await ollamaHasModel())) {
    console.log(
      `    NOT RUN: Ollama is not answering on ${OLLAMA_URL}, or \`${OLLAMA_MODEL}\` is not pulled (ollama pull ${OLLAMA_MODEL})`
    );
    notRun.push('routing to a local Ollama model');
    return;
  }
  await prisma.aiProviderConfig.create({
    data: {
      slug: OLLAMA_PROVIDER,
      name: 'Smoke Privacy Ollama',
      providerType: 'openai-compatible',
      baseUrl: `${OLLAMA_URL}/v1`,
      isLocal: true,
      isActive: true,
    },
  });
  await prisma.aiProviderModel.create({
    data: {
      slug: `${OLLAMA_PROVIDER}-model`,
      providerSlug: OLLAMA_PROVIDER,
      modelId: OLLAMA_MODEL,
      name: `Smoke ${OLLAMA_MODEL}`,
      description: 'Throwaway model row for scripts/smoke/privacy-leak.ts — safe to delete.',
      capabilities: ['chat'],
      tierRole: 'worker',
      deploymentProfiles: ['sovereign'],
      local: true,
      reasoningDepth: 'none',
      latency: 'fast',
      costEfficiency: 'very_high',
      contextLength: 'medium',
      toolUse: 'none',
      bestRole: 'Smoke test',
    },
  });
  await prisma.aiOrchestrationSettings.update({
    where: { slug: 'global' },
    data: { confidentialModelProvider: OLLAMA_PROVIDER, confidentialModel: OLLAMA_MODEL },
  });
  await setPrivacy('off', 'allow', 'local_only', 'allow');

  const agent = await prisma.aiAgent.create({
    data: {
      slug: `${AGENT_SLUG}-moved`,
      name: 'Smoke Privacy Agent (moved)',
      description: 'Throwaway agent for scripts/smoke/privacy-leak.ts — safe to delete.',
      provider: CHAT_PROVIDER,
      model: 'fake-model-1',
      systemInstructions: 'You are an HR assistant. Answer in one short sentence.',
      maxTokens: 60,
      isActive: true,
      createdBy: userId,
    },
  });
  const received: LlmMessage[][] = [];
  registerProviderInstance(CHAT_PROVIDER, plainChatProvider(received));
  const turn = async (message: string, conversationId?: string) => {
    const events: ChatEvent[] = [];
    for await (const event of streamChat({
      message,
      agentSlug: agent.slug,
      userId,
      ...(conversationId ? { conversationId } : {}),
    })) {
      events.push(event);
    }
    const started = events.find((e) => e.type === 'start');
    return { events, conversationId: started?.type === 'start' ? started.conversationId : null };
  };

  const moved = await turn(`${DISCLOSURE}. How do I tell my manager?`);
  const reply = moved.events
    .map((e) => (e.type === 'content' ? e.delta : ''))
    .join('')
    .trim();
  const error = moved.events.find((e) => e.type === 'error');
  const notes = moved.events.filter((e) => e.type === 'warning');
  console.log(
    `    cloud provider calls: ${received.length}; error: ${JSON.stringify(error ?? null)}`
  );
  console.log(`    notes: ${JSON.stringify(notes)}`);
  console.log(`    ${OLLAMA_MODEL} replied: ${JSON.stringify(reply)}`);
  check(received.length === 0, 'the cloud provider received nothing');
  check(!error && reply.length > 0, 'the turn was answered');
  check(
    notes.length === 1 && notes[0].type === 'warning' && notes[0].code === 'confidential_moved',
    'the user is told once that the conversation moved'
  );
  if (!moved.conversationId) throw new Error('the moved turn never started');
  const answer = await prisma.aiMessage.findFirst({
    where: { conversationId: moved.conversationId, role: 'assistant' },
    select: { providerSlug: true, modelId: true },
  });
  console.log(`    saved answer: ${JSON.stringify(answer)}`);
  check(
    answer?.providerSlug === OLLAMA_PROVIDER && answer.modelId === OLLAMA_MODEL,
    'the saved answer names the local model that wrote it'
  );
  const cost = await prisma.aiCostLog.findFirst({
    where: { conversationId: moved.conversationId },
    select: { provider: true, model: true },
  });
  console.log(`    cost row: ${JSON.stringify(cost)}`);
  check(cost?.model === OLLAMA_MODEL, 'the turn is costed against the local model');

  const next = await turn('What is the holiday policy?', moved.conversationId);
  check(
    received.length === 0 && !next.events.some((e) => e.type === 'error'),
    'the next turn stays on the local model'
  );
  check(!next.events.some((e) => e.type === 'warning'), 'and is not told again');
}

async function cleanUp(): Promise<void> {
  const agents = await prisma.aiAgent.findMany({
    where: { slug: { startsWith: AGENT_SLUG } },
    select: { id: true },
  });
  for (const { id } of agents) {
    await prisma.aiMessage.deleteMany({ where: { conversation: { agentId: id } } });
    await prisma.aiCostLog.deleteMany({ where: { agentId: id } });
    await prisma.aiConversation.deleteMany({ where: { agentId: id } });
    await prisma.aiAgent.delete({ where: { id } });
  }
  await prisma.aiProviderModel.deleteMany({ where: { providerSlug: OLLAMA_PROVIDER } });
  await prisma.aiProviderConfig.deleteMany({ where: { slug: OLLAMA_PROVIDER } });
  const workflows = await prisma.aiWorkflow.findMany({
    where: { slug: { startsWith: WORKFLOW_SLUG } },
    select: { id: true },
  });
  for (const { id } of workflows) {
    const runs = await prisma.aiWorkflowExecution.findMany({
      where: { workflowId: id },
      select: { id: true },
    });
    await prisma.aiCostLog.deleteMany({
      where: { workflowExecutionId: { in: runs.map((r) => r.id) } },
    });
    await prisma.aiWorkflowExecution.deleteMany({ where: { workflowId: id } });
    await prisma.aiWorkflow.delete({ where: { id } });
  }
}

async function chatTurn(userId: string): Promise<void> {
  console.log('\n════ chat turn, pseudonymise ════');
  const capability = await prisma.aiCapability.findFirst({
    where: { slug: 'search_knowledge_base', isActive: true },
    select: { id: true },
  });
  if (!capability) throw new Error('search_knowledge_base is not seeded: run npm run db:seed');
  const agent = await prisma.aiAgent.create({
    data: {
      slug: AGENT_SLUG,
      name: 'Smoke Privacy Agent',
      description: 'Throwaway agent for scripts/smoke/privacy-leak.ts — safe to delete.',
      provider: CHAT_PROVIDER,
      model: 'fake-model-1',
      systemInstructions: 'You are a support agent.',
      isActive: true,
      createdBy: userId,
      capabilities: { create: { capabilityId: capability.id } },
    },
  });

  const received: LlmMessage[][] = [];
  registerProviderInstance(CHAT_PROVIDER, chatProvider(received));

  const events: ChatEvent[] = [];
  let conversationId: string | null = null;
  for await (const event of streamChat({
    message: `Hi, I'm ${NAME}. My email is ${EMAIL} and my NI number is ${NINO}. What do you have on me?`,
    agentSlug: agent.slug,
    userId,
  })) {
    events.push(event);
    if (event.type === 'start') conversationId = event.conversationId;
  }
  if (!conversationId) throw new Error('the turn never started');

  const reply = events.flatMap((e) => (e.type === 'content' ? [e.delta] : [])).join('');
  console.log(`    provider calls: ${received.length}; reply: "${reply}"`);
  check(received.length === 2, 'the tool loop made two provider calls');
  check(
    leaked(received).length === 0,
    `no seeded value reached the provider (${leaked(received).join(', ') || 'none'})`
  );
  check(reply === `Thanks ${NAME}, I have noted ${EMAIL}.`, 'the user sees the reply restored');

  const rows = await prisma.aiMessage.findMany({
    where: { conversationId },
    select: { role: true, content: true, metadata: true },
  });
  const toolRow = rows.find((r) => r.role === 'tool');
  const stored = JSON.stringify(toolRow?.metadata ?? null);
  check(
    stored.includes(`"query":"${NAME} ${EMAIL}"`),
    'search_knowledge_base was dispatched with the real name and email'
  );
  check(
    stored.includes('embeddings_local_only') || stored.includes('local embedding model'),
    'under local_only the search returned the relayable tool error'
  );
  const assistant = rows
    .filter((r) => r.role === 'assistant')
    .map((r) => r.content)
    .join(' ');
  check(
    !/\[(PERSON|EMAIL|UK_NINO)_\d+\]/.test(assistant),
    'no placeholder was persisted in the reply'
  );
}

async function workflowStep(userId: string, mode: 'pseudonymise' | 'off'): Promise<void> {
  console.log(`\n════ workflow llm_call, ${mode} ════`);
  const received: LlmMessage[][] = [];
  registerProviderInstance(WORKFLOW_PROVIDER, workflowProvider(received));
  const definition: WorkflowDefinition = {
    entryStepId: 'summarise',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'summarise',
        name: 'Summarise',
        type: 'llm_call',
        config: {
          prompt: 'Summarise this note: {{input.note}}',
          modelOverride: WORKFLOW_MODEL,
        },
        nextSteps: [],
      },
    ],
  };
  const workflow = await prisma.aiWorkflow.create({
    data: {
      name: `${PREFIX} ${mode}`,
      slug: `${WORKFLOW_SLUG}-${mode}-${Date.now()}`,
      description: 'smoke',
      orgId: INSTALL_ORG_ID,
      // The engine runs `definition` as passed; the row only has to exist.
      draftDefinition: { steps: [] },
      createdBy: userId,
    },
  });

  let output: unknown = null;
  for await (const event of new OrchestrationEngine().execute(
    { id: workflow.id, definition },
    { note: `${NAME} (${EMAIL}, NI ${NINO}) wants a callback.` },
    { userId }
  )) {
    if (event.type === 'step_completed') output = event.output;
    if (event.type === 'workflow_failed') console.log('    workflow failed:', event.error);
  }

  console.log(`    provider calls: ${received.length}; output: ${JSON.stringify(output)}`);
  check(received.length === 1, 'the step made one provider call');
  if (mode === 'pseudonymise') {
    check(
      leaked(received).length === 0,
      `no seeded value reached the provider (${leaked(received).join(', ') || 'none'})`
    );
    check(output === `Summary: ${NAME} asked for a callback.`, "the step's output is restored");
  } else {
    check(leaked(received).length === SEEDED.length, 'mode off sends the request unchanged');
  }
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error('No user rows in the dev DB: seed one first.');
  const before = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: {
      privacyMode: true,
      privacyEmbeddingsPolicy: true,
      privacyConfidentialPersonal: true,
      privacyConfidentialCommercial: true,
      confidentialModelProvider: true,
      confidentialModel: true,
    },
  });
  if (!before) throw new Error('No orchestration settings row: open the settings page once.');

  await cleanUp();
  try {
    await setPrivacy('pseudonymise', 'local_only');
    await chatTurn(user.id);
    await workflowStep(user.id, 'pseudonymise');
    await setPrivacy('off', 'allow');
    await workflowStep(user.id, 'off');
    // Refused, not moved: no model for confidential messages yet.
    await prisma.aiOrchestrationSettings.update({
      where: { slug: 'global' },
      data: { confidentialModelProvider: null, confidentialModel: null },
    });
    await confidentialTurns(user.id);
    await movedToLocalModel(user.id);
  } finally {
    await prisma.aiOrchestrationSettings.update({
      where: { slug: 'global' },
      data: {
        confidentialModelProvider: before.confidentialModelProvider,
        confidentialModel: before.confidentialModel,
      },
    });
    await setPrivacy(
      before.privacyMode,
      before.privacyEmbeddingsPolicy,
      before.privacyConfidentialPersonal,
      before.privacyConfidentialCommercial
    );
    // The turn's reply embedding is fire-and-forget: let it settle first.
    await new Promise((r) => setTimeout(r, 500));
    await cleanUp();
    console.log(
      `\n[cleanup] settings restored (${before.privacyMode}, ${before.privacyEmbeddingsPolicy}); smoke rows removed`
    );
  }

  await prisma.$disconnect();
  if (failures > 0) {
    console.error(`\n✗ ${failures} check(s) failed`);
    process.exit(1);
  }
  if (notRun.length > 0) {
    console.log(`\n✓ privacy leak smoke passed, but NOT RUN: ${notRun.join('; ')}`);
    return;
  }
  console.log('\n✓ privacy leak smoke passed');
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' }).catch(async (err) => {
  console.error('\n✗ smoke script failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
