/**
 * send_message_to_channel targeting smoke script (t-770)
 *
 * Proves, against the real Postgres dev DB, which conversation each kind of
 * caller may send on. A workflow run may send only on its
 * `AiWorkflowExecution.replyConversationId`, which the inbound route sets and
 * the rerun route copies; this also proves the column behaves (a rerun of a
 * rerun, a purged original, an erased conversation clearing it).
 *
 * Also runs the inbound-reply template's real `send_reply` step through the
 * real dispatcher. That step never sent before t-770: `tool_call` did not
 * interpolate its args, so `{{trigger.conversationId}}` arrived as literal
 * text and the capability answered `conversation_not_found`.
 *
 * No message is actually sent: no outbound adapter is registered, so a
 * permitted call ends at `provider_not_registered`. Every check asserts the
 * exact code: a permitted call must reach that stage (past the targeting check
 * and the conversation lookup), a refused one must carry
 * `conversation_not_permitted`. An earlier draft checked only "not refused",
 * which a sabotaged build also satisfied.
 *
 * Run with:
 *   npm run smoke:send-message-target
 *   # or:
 *   npx tsx --env-file=.env.local scripts/smoke/send-message-target.ts
 */

import { prisma } from '@/lib/db/client';
import { runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { SendMessageToChannelCapability } from '@/lib/orchestration/capabilities/built-in/send-message-to-channel';
import { executeToolCall } from '@/lib/orchestration/engine/executors/tool-call';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { INBOUND_CONVERSATION_HANDLER_TEMPLATE } from '@/prisma/seeds/data/templates/inbound-conversation-handler';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import type { WorkflowStep } from '@/types/orchestration';

const PREFIX = 'smoke-send-target';
const stamp = Date.now();

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`    ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

const REFUSED = 'conversation_not_permitted';
/** Where a permitted call ends here: past targeting and lookup, no adapter registered. */
const PERMITTED = 'provider_not_registered';

let attempts = 0;
async function attempt(conversationId: string, context: CapabilityContext): Promise<string> {
  // A distinct message per attempt, so permitted calls never share a dedup key.
  attempts += 1;
  const result = await new SendMessageToChannelCapability().execute(
    { conversationId, message: `smoke ${stamp} #${attempts}` },
    context
  );
  return result.success ? 'sent' : (result.error?.code ?? 'unknown');
}

function silentLogger(): ExecutionContext['logger'] {
  const noop = () => undefined;
  const log = { info: noop, warn: noop, error: noop, debug: noop, withContext: () => log };
  return log as unknown as ExecutionContext['logger'];
}

async function cleanup(): Promise<void> {
  const workflows = await prisma.aiWorkflow.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = workflows.map((w) => w.id);
  if (ids.length > 0) {
    await prisma.aiWorkflowExecution.deleteMany({
      where: { workflowId: { in: ids }, parentExecutionId: { not: null } },
    });
    await prisma.aiWorkflowExecution.deleteMany({ where: { workflowId: { in: ids } } });
    await prisma.aiWorkflow.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.aiConversation.deleteMany({ where: { title: { startsWith: PREFIX } } });
}

async function main(): Promise<void> {
  await cleanup();

  // ── Seed ──────────────────────────────────────────────────────────────
  const agent = await prisma.aiAgent.findFirst({ select: { id: true } });
  if (!agent) throw new Error('No agent in the dev DB; run db:seed first.');
  const conversation = (label: string) =>
    prisma.aiConversation.create({
      data: {
        agentId: agent.id,
        title: `${PREFIX} ${label}`,
        channel: 'sms',
        provider: 'twilio',
        fromAddress: `+4474000${String(stamp).slice(-5)}${'ABC'.indexOf(label) + 1}`,
      },
    });
  const convA = await conversation('A');
  const convB = await conversation('B');
  const workflow = await prisma.aiWorkflow.create({
    data: { name: `${PREFIX} workflow`, slug: `${PREFIX}-${stamp}`, description: 'smoke' },
  });
  const run = (data: {
    triggerSource?: string;
    parentExecutionId?: string;
    replyConversationId?: string;
  }) =>
    prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'running',
        ...(data.triggerSource ? { triggerSource: data.triggerSource } : {}),
        ...(data.parentExecutionId ? { parentExecutionId: data.parentExecutionId } : {}),
        ...(data.replyConversationId ? { replyConversationId: data.replyConversationId } : {}),
        // Every run's input names conversation A in its envelope, and the
        // sender's payload names B: neither is what authorises a send.
        inputData: {
          trigger: { text: 'Hi', conversationId: convB.id },
          triggerMeta: { channel: 'sms', conversationId: convA.id },
        },
        executionTrace: [],
      },
    });
  // As the inbound route creates a run, and as the rerun route copies it.
  const inbound = await run({ triggerSource: 'inbound:sms', replyConversationId: convA.id });
  const rerun = await run({ parentExecutionId: inbound.id, replyConversationId: convA.id });
  const rerunOfRerun = await run({ parentExecutionId: rerun.id, replyConversationId: convA.id });
  // A rerun whose original has since been purged.
  const doomed = await run({ triggerSource: 'inbound:sms', replyConversationId: convA.id });
  const orphanRerun = await run({ parentExecutionId: doomed.id, replyConversationId: convA.id });
  await prisma.aiWorkflowExecution.delete({ where: { id: doomed.id } });
  // What a model calling run_workflow, an admin, or a schedule starts: no reply conversation.
  const unanchored = await run({});
  console.log('[1] seeded two SMS conversations and five runs');

  try {
    const step = (executionId: string, agentId = 'smoke-agent') => ({
      userId: null,
      agentId,
      workflowExecutionId: executionId,
    });

    // ── The template's real reply step, end to end ──────────────────────
    console.log('\n[2] the inbound-reply template’s send_reply step, through the real dispatcher');
    const sendReply = INBOUND_CONVERSATION_HANDLER_TEMPLATE.workflowDefinition.steps.find(
      (s): s is WorkflowStep => s.id === 'send_reply'
    );
    if (!sendReply) throw new Error('template has no send_reply step');
    const outcome = await executeToolCall(sendReply, {
      executionId: inbound.id,
      workflowId: workflow.id,
      userId: null,
      inputData: {
        trigger: { text: 'Hi' },
        triggerMeta: { channel: 'sms', conversationId: convA.id },
      },
      stepOutputs: { respond_to_inbound: 'Happy to help.' },
      variables: {},
      totalTokensUsed: 0,
      totalCostUsd: 0,
      defaultErrorStrategy: 'fail',
      logger: silentLogger(),
    }).then(
      () => 'sent',
      (err: unknown) => (err instanceof ExecutorError ? err.code : String(err))
    );
    check(
      outcome === PERMITTED,
      `it is permitted and finds the conversation: {{trigger.conversationId}} was filled in (got ${outcome})`
    );

    // ── Each caller ─────────────────────────────────────────────────────
    console.log('\n[3] a workflow step may send only on its run’s reply conversation');
    check(
      (await attempt(convA.id, step(inbound.id))) === PERMITTED,
      'inbound run → its reply conversation: permitted'
    );
    check(
      (await attempt(convB.id, step(inbound.id))) === REFUSED,
      'inbound run → another conversation (even one its sender’s payload names): refused'
    );
    check(
      (await attempt(convA.id, step(rerun.id))) === PERMITTED,
      'an admin’s rerun → the same conversation: permitted'
    );
    check(
      (await attempt(convA.id, step(rerunOfRerun.id))) === PERMITTED,
      'a rerun of a rerun → the same conversation: permitted'
    );
    check(
      (await attempt(convA.id, step(orphanRerun.id))) === PERMITTED,
      'a rerun whose original was purged → still permitted'
    );
    check(
      (await attempt(convA.id, step(unanchored.id))) === REFUSED,
      'a run no inbound message started, whatever its input says: refused'
    );

    console.log('\n[4] chat and MCP');
    check(
      (await attempt(convA.id, {
        userId: null,
        agentId: 'smoke-agent',
        conversationId: convB.id,
      })) === REFUSED,
      'a chat turn → a conversation other than its own: refused'
    );
    check(
      (await attempt(convA.id, { userId: null, agentId: 'smoke-agent' })) === REFUSED,
      'an MCP client (no conversation of its own): refused'
    );

    console.log('\n[5] erasing the conversation clears the run’s permission');
    const convC = await conversation('C');
    const replying = await run({ triggerSource: 'inbound:sms', replyConversationId: convC.id });
    await prisma.aiConversation.delete({ where: { id: convC.id } });
    const after = await prisma.aiWorkflowExecution.findUnique({
      where: { id: replying.id },
      select: { replyConversationId: true },
    });
    check(
      after?.replyConversationId === null,
      'the run’s replyConversationId is cleared (SetNull)'
    );
  } finally {
    await cleanup();
    console.log('\n[6] cleaned up the smoke conversations, runs and workflow');
  }

  await prisma.$disconnect();
  if (failures > 0) {
    console.error(`\n✗ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ send_message_to_channel targeting smoke passed');
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
