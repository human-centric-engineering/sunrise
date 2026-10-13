/**
 * Erasure of a person from delivery payloads and colleagues' subscriptions
 * (t-783, t-786).
 *
 * Proves, against a real Postgres, what mocked tests cannot: the raw SQL in
 * `lib/privacy/delivery-payloads.ts` (JSON containment, the joins through the
 * subject's conversations and runs, the bulk rewrite) and the subscription
 * clear in `eraseUser()` (an address normalised in SQL). In order:
 *
 *   1. Before erasure, the subject-access export finds every delivery whose
 *      payload names the subject — by their id, a conversation of theirs, a
 *      run of theirs, as the actor, or as an approver — and none that does
 *      not, and hands them no colleague's id.
 *   2. After erasure, no delivery payload holds the subject's id; an event
 *      about their activity keeps only its record keys, so the free text in
 *      it is gone; one still retrying is stopped; one about a change they made
 *      keeps the change and loses only them. Each keeps its destination.
 *   3. A colleague's email subscription to the subject's address (typed in a
 *      different case) is cleared and deactivated, with an audit entry that
 *      does not hold the address. A subscription to anyone else is untouched.
 *   4. An unverified account's address leaves a colleague's subscription to
 *      it untouched: it may be a stranger's inbox.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-test-erasure-deliv-*` rows and removes whatever it created.
 *
 * Run with:
 *   npm run smoke:erasure-deliveries
 *   npx tsx --env-file=.env.local scripts/smoke/erasure-deliveries.ts
 */

import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { eraseUser } from '@/lib/privacy/erase-user';
import { SUBJECT_DATA_SOURCES } from '@/lib/privacy/export-sources';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { runAsOrg } from '@/lib/tenancy/context';

const PREFIX = 'smoke-test-erasure-deliv';
const stamp = Date.now();

/** Free text an activity event carries; must not survive the erasure. */
const SECRET_TEXT = `subject-said-${stamp}`;

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function dataOf(payload: Prisma.JsonValue): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const data = payload.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  }
  throw new Error('payload has no data object');
}

function idsOf(rows: unknown[]): string[] {
  return rows.map((row) => {
    if (row && typeof row === 'object' && 'id' in row && typeof row.id === 'string') return row.id;
    throw new Error('export row without an id');
  });
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log(
      'smoke:erasure-deliveries skipped — no database reachable (DATABASE_URL unset or DB down).'
    );
    return;
  }

  const userIds: string[] = [];
  const subscriptionIds: string[] = [];
  const webhookDeliveryIds: string[] = [];
  const hookDeliveryIds: string[] = [];
  const auditIds: string[] = [];
  const receiptIds: string[] = [];
  let workflowId: string | null = null;
  let hookId: string | null = null;

  try {
    const makeUser = async (label: string, verified: boolean) => {
      const user = await prisma.user.create({
        data: {
          name: `${PREFIX} ${label}`,
          email: `${PREFIX}-${label}-${stamp}@example.com`,
          emailVerified: verified,
          role: PLATFORM_ADMIN_ROLE,
        },
      });
      userIds.push(user.id);
      await prisma.orgMembership.create({
        data: { orgId: INSTALL_ORG_ID, userId: user.id, role: ORG_OWNER_ROLE },
      });
      return user;
    };
    const subject = await makeUser('subject', true);
    const colleague = await makeUser('colleague', true);
    const unverified = await makeUser('unverified', false);

    // The subject's own conversation and run; the colleague's, for contrast.
    const agent = await prisma.aiAgent.findFirstOrThrow({ select: { id: true, slug: true } });
    const conversation = await prisma.aiConversation.create({
      data: { userId: subject.id, agentId: agent.id, title: `${PREFIX} convo` },
    });
    const colleagueConversation = await prisma.aiConversation.create({
      data: { userId: colleague.id, agentId: agent.id, title: `${PREFIX} colleague convo` },
    });
    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} workflow`,
        slug: `${PREFIX}-workflow-${stamp}`,
        description: 'smoke',
        createdBy: colleague.id,
      },
    });
    workflowId = workflow.id;
    const execution = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'failed',
        inputData: {},
        executionTrace: [],
        userId: subject.id,
      },
    });
    const colleagueExecution = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'paused_for_approval',
        inputData: {},
        executionTrace: [],
        userId: colleague.id,
      },
    });

    const webhook = async (
      eventType: string,
      data: Prisma.InputJsonObject,
      status = 'delivered'
    ) => {
      const row = await prisma.aiWebhookDelivery.create({
        data: {
          eventType,
          payload: { event: eventType, data },
          status,
          nextRetryAt: status === 'failed' ? new Date(Date.now() + 3_600_000) : null,
          destination: 'https://receiver.smoke-test.example',
          destinationFingerprint: `v1:${PREFIX}`,
        },
      });
      webhookDeliveryIds.push(row.id);
      return row;
    };
    const hookRow = async (eventType: string, data: Prisma.InputJsonObject) => {
      const row = await prisma.aiEventHookDelivery.create({
        data: {
          hookId,
          eventType,
          payload: {
            eventType,
            timestamp: new Date().toISOString(),
            data,
          },
          status: 'delivered',
          destination: 'https://hook.smoke-test.example',
        },
      });
      hookDeliveryIds.push(row.id);
      return row;
    };
    const hook = await prisma.aiEventHook.create({
      data: {
        name: `${PREFIX} hook`,
        eventType: `${PREFIX}-${stamp}`,
        action: { type: 'webhook', url: 'https://hook.smoke-test.example/in' },
        isEnabled: false,
        createdBy: colleague.id,
      },
    });
    hookId = hook.id;

    const escalated = await webhook('conversation_escalated', {
      agentId: agent.id,
      userId: subject.id,
      conversationId: conversation.id,
      reason: SECRET_TEXT,
      priority: 'high',
      metadata: { note: SECRET_TEXT },
    });
    // Names the subject only through their conversation, and is still retrying.
    const perTurn = await webhook(
      'chat_budget_exceeded_per_turn',
      { agentId: agent.id, conversationId: conversation.id, usedUsd: 0.5, limitUsd: 0.1 },
      'failed'
    );
    // Names the subject only through their run, with free text.
    const notified = await webhook('workflow_notification', {
      workflowId: workflow.id,
      executionId: execution.id,
      body: SECRET_TEXT,
    });
    // A change the subject made: retrying, and the change is the org's.
    const agentUpdated = await webhook(
      'agent_updated',
      {
        agentId: agent.id,
        actorUserId: subject.id,
        actorUserName: subject.name,
        changes: { temperature: { from: 0.2, to: 0.7 } },
      },
      'failed'
    );
    // The subject was one of the approvers on a colleague's run.
    const approval = await webhook('approval_required', {
      executionId: colleagueExecution.id,
      workflowId: workflow.id,
      userId: colleague.id,
      actorUserId: colleague.id,
      actorUserName: colleague.name,
      approverUserIds: [subject.id, colleague.id],
      prompt: 'Approve the colleague’s run',
    });
    // The subject's own failed run, already pruned by retention: only
    // `actorUserId` still names them, and on a non-admin event that is the
    // run's owner, so the row is their activity — free text and all.
    const prunedRun = await webhook(
      'workflow_failed',
      {
        executionId: `${PREFIX}-pruned-run-${stamp}`,
        workflowId: workflow.id,
        actorUserId: subject.id,
        actorUserName: subject.name,
        error: SECRET_TEXT,
      },
      'failed'
    );
    // Nothing to do with the subject.
    const unrelated = await webhook('conversation_escalated', {
      agentId: agent.id,
      userId: colleague.id,
      conversationId: colleagueConversation.id,
      reason: 'the colleague’s own words',
    });
    const messageHook = await hookRow('message.created', {
      conversationId: conversation.id,
      messageId: `${PREFIX}-msg`,
      agentSlug: agent.slug,
      userId: subject.id,
      role: 'user',
    });
    const failedHook = await hookRow('workflow.failed', {
      executionId: execution.id,
      workflowId: workflow.id,
      source: 'admin-force-fail',
      errorMessage: SECRET_TEXT,
    });
    const forceFailed = await hookRow('execution.force_failed', {
      executionId: execution.id,
      workflowId: workflow.id,
      actorUserId: colleague.id,
      reason: 'stuck',
    });
    const unrelatedHook = await hookRow('message.created', {
      conversationId: colleagueConversation.id,
      userId: colleague.id,
      role: 'user',
    });

    // Colleagues' email subscriptions: to the subject (typed in another case),
    // to someone else, and to the unverified account.
    const subscribe = async (emailAddress: string) => {
      const sub = await prisma.aiWebhookSubscription.create({
        data: {
          channel: 'email',
          emailAddress,
          events: [`${PREFIX}-${stamp}`],
          description: `${PREFIX} subscription`,
          createdBy: colleague.id,
        },
      });
      subscriptionIds.push(sub.id);
      return sub;
    };
    const toSubject = await subscribe(subject.email.toUpperCase());
    // Stored as typed, stray whitespace included: matched by the same
    // normalisation the deliveries are recorded with, not a SQL lookalike.
    const toSubjectPadded = await subscribe(` ${subject.email}\t`);
    const toOther = await subscribe(`${PREFIX}-someone-else-${stamp}@example.com`);
    const toUnverified = await subscribe(unverified.email);

    // ── 1. Subject access finds what names them ──
    console.log('Subject access, before erasure:');
    const source = (section: string) => {
      const found = SUBJECT_DATA_SOURCES.find((s) => s.section === section);
      if (!found) throw new Error(`no subject source for ${section}`);
      return found;
    };
    const query = { userId: subject.id, email: subject.email, emailVerified: true };
    const webhookRows = await source('webhookDeliveries').fetch(query);
    const hookRows = await source('eventHookDeliveries').fetch(query);
    const webhookIds = idsOf(webhookRows);
    check(
      [escalated, perTurn, notified, agentUpdated, approval, prunedRun].every((r) =>
        webhookIds.includes(r.id)
      ),
      'every webhook delivery naming the subject is exported (id, conversation, run, actor, approver)'
    );
    check(!webhookIds.includes(unrelated.id), 'a colleague’s escalation is not');
    const hookIds = idsOf(hookRows);
    check(
      [messageHook, failedHook, forceFailed].every((r) => hookIds.includes(r.id)),
      'every event-hook delivery naming the subject is exported'
    );
    check(!hookIds.includes(unrelatedHook.id), 'a colleague’s message event is not');
    const exportedText = JSON.stringify([...webhookRows, ...hookRows]);
    check(exportedText.includes(SECRET_TEXT), 'the export carries what their own events said');
    check(
      !exportedText.includes(colleague.id),
      'and no colleague’s id: not the approver list, not the admin who force-failed their run'
    );

    // ── 2. Erasure redacts the payloads ──
    console.log('Erasing the subject:');
    const erased = await eraseUser({
      userId: subject.id,
      userEmail: subject.email,
      actorUserId: subject.id,
      reason: 'self_service',
    });
    receiptIds.push(erased.receiptId);

    const webhookAfter = await prisma.aiWebhookDelivery.findMany({
      where: { id: { in: webhookDeliveryIds } },
    });
    const hookAfter = await prisma.aiEventHookDelivery.findMany({
      where: { id: { in: hookDeliveryIds } },
    });
    const byId = new Map(
      [...webhookAfter, ...hookAfter].map((row) => [row.id, row] as [string, typeof row])
    );
    const row = (id: string) => {
      const found = byId.get(id);
      if (!found) throw new Error(`delivery ${id} is gone`);
      return found;
    };
    check(
      byId.size === webhookDeliveryIds.length + hookDeliveryIds.length,
      'every delivery survives'
    );
    const afterText = JSON.stringify([...webhookAfter, ...hookAfter].map((r) => r.payload));
    check(!afterText.includes(subject.id), 'no delivery payload holds the subject’s id');
    check(!afterText.includes(SECRET_TEXT), 'nor anything their own events said');
    check(!afterText.includes(subject.name ?? `${PREFIX} subject`), 'nor their name');

    const escalatedData = dataOf(row(escalated.id).payload);
    check(
      escalatedData.userId === null &&
        escalatedData.agentId === agent.id &&
        escalatedData.priority === 'high' &&
        !('reason' in escalatedData) &&
        !('metadata' in escalatedData),
      'an escalation keeps which agent and how urgent, and loses who and why'
    );
    check(
      row(escalated.id).destination === 'https://receiver.smoke-test.example',
      'and its destination'
    );
    const perTurnAfter = webhookAfter.find((r) => r.id === perTurn.id);
    check(
      perTurnAfter?.status === 'exhausted' &&
        perTurnAfter.nextRetryAt === null &&
        (perTurnAfter.lastError ?? '').includes('subject erased'),
      'an event about their conversation that was retrying is stopped'
    );
    const agentUpdatedAfter = webhookAfter.find((r) => r.id === agentUpdated.id);
    const agentUpdatedData = dataOf(row(agentUpdated.id).payload);
    check(
      agentUpdatedData.actorUserId === null &&
        !('actorUserName' in agentUpdatedData) &&
        isDeepStrictEqual(agentUpdatedData.changes, { temperature: { from: 0.2, to: 0.7 } }),
      'a change they made keeps the change and loses only them'
    );
    check(agentUpdatedAfter?.status === 'failed', 'and keeps retrying: the event is the org’s');
    const prunedRunAfter = webhookAfter.find((r) => r.id === prunedRun.id);
    const prunedRunData = dataOf(row(prunedRun.id).payload);
    check(
      prunedRunData.actorUserId === null &&
        !('actorUserName' in prunedRunData) &&
        !('error' in prunedRunData) &&
        prunedRunAfter?.status === 'exhausted',
      'a failed run of theirs that retention already pruned is still their activity: free text gone, retry stopped'
    );
    const approvalData = dataOf(row(approval.id).payload);
    check(
      isDeepStrictEqual(approvalData.approverUserIds, [colleague.id]) &&
        approvalData.actorUserId === colleague.id &&
        approvalData.prompt === 'Approve the colleague’s run',
      'an approval on a colleague’s run loses only the subject from its approvers'
    );
    check(
      isDeepStrictEqual(row(unrelated.id).payload, unrelated.payload),
      'a colleague’s escalation is untouched'
    );
    const forceFailedData = dataOf(row(forceFailed.id).payload);
    check(
      forceFailedData.actorUserId === colleague.id && !('reason' in forceFailedData),
      'an admin’s force-fail of their run keeps the admin and loses the free text'
    );
    check(
      isDeepStrictEqual(row(unrelatedHook.id).payload, unrelatedHook.payload),
      'a colleague’s message event is untouched'
    );

    // ── 3. A colleague's subscription to them is cleared and deactivated ──
    console.log('Colleagues’ subscriptions:');
    const toSubjectAfter = await prisma.aiWebhookSubscription.findUniqueOrThrow({
      where: { id: toSubject.id },
    });
    check(
      toSubjectAfter.emailAddress === null && !toSubjectAfter.isActive,
      'the one emailing the subject (typed in upper case) is cleared and deactivated'
    );
    const audit = await prisma.aiAdminAuditLog.findMany({
      where: { action: 'webhook_subscription.recipient_erased', entityId: toSubject.id },
    });
    auditIds.push(...audit.map((a) => a.id));
    check(audit.length === 1, 'with one audit entry');
    const paddedAfter = await prisma.aiWebhookSubscription.findUniqueOrThrow({
      where: { id: toSubjectPadded.id },
    });
    check(
      paddedAfter.emailAddress === null && !paddedAfter.isActive,
      'so is one stored with surrounding spaces and a tab'
    );
    check(
      !JSON.stringify(audit).toLowerCase().includes(subject.email.toLowerCase()),
      'that does not hold the address'
    );
    const toOtherAfter = await prisma.aiWebhookSubscription.findUniqueOrThrow({
      where: { id: toOther.id },
    });
    check(
      toOtherAfter.emailAddress === toOther.emailAddress && toOtherAfter.isActive,
      'one emailing someone else is untouched'
    );

    // ── 4. An unverified address touches nothing ──
    console.log('An unverified account:');
    const erasedUnverified = await eraseUser({
      userId: unverified.id,
      userEmail: unverified.email,
      actorUserId: colleague.id,
      reason: 'admin_action',
    });
    receiptIds.push(erasedUnverified.receiptId);
    const toUnverifiedAfter = await prisma.aiWebhookSubscription.findUniqueOrThrow({
      where: { id: toUnverified.id },
    });
    check(
      toUnverifiedAfter.emailAddress === unverified.email && toUnverifiedAfter.isActive,
      'a colleague’s subscription to an unverified address is untouched'
    );

    console.log('\nsmoke:erasure-deliveries passed');
  } finally {
    // Scoped cleanup: only the ids this run created.
    await prisma.aiWebhookDelivery.deleteMany({ where: { id: { in: webhookDeliveryIds } } });
    await prisma.aiEventHookDelivery.deleteMany({ where: { id: { in: hookDeliveryIds } } });
    await prisma.aiWebhookSubscription.deleteMany({ where: { id: { in: subscriptionIds } } });
    if (hookId) await prisma.aiEventHook.delete({ where: { id: hookId } }).catch(() => undefined);
    // The executions and conversations cascade with their users and workflow.
    await prisma.aiAdminAuditLog.deleteMany({
      where: {
        OR: [
          { id: { in: auditIds } },
          {
            action: 'webhook_subscription.recipient_erased',
            entityId: { in: subscriptionIds },
          },
        ],
      },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (workflowId) {
      await prisma.aiWorkflow.delete({ where: { id: workflowId } }).catch(() => undefined);
    }
    await prisma.dataErasureReceipt.deleteMany({ where: { id: { in: receiptIds } } });
  }
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
