/**
 * Erasure of a person from delivery payloads and colleagues' subscriptions
 * (t-783, t-786, t-792).
 *
 * Proves, against a real Postgres, what mocked tests cannot: the raw SQL in
 * `lib/privacy/delivery-payloads.ts` (JSON containment, the joins through the
 * subject's conversations and runs, the bulk rewrite) and the subscription
 * clear in `eraseUser()` against real rows (an address stored as typed, in
 * another case and with stray whitespace). In order:
 *
 *   1. Before erasure, the subject-access export finds every delivery whose
 *      payload names the subject — by their id, a conversation of theirs, a
 *      run of theirs, as the actor, or as an approver — and none that does
 *      not, and hands them no colleague's id.
 *   2. After erasure, no delivery payload holds the subject's id; an event
 *      about their activity keeps only its record keys, so the free text in
 *      it is gone; one still retrying is stopped, and every one is marked so
 *      a retry refuses it, delivered or exhausted; one about a change they made
 *      keeps the change and loses only them. Each keeps its destination.
 *   3. A colleague's email subscription to the subject's address (typed in a
 *      different case) is cleared and deactivated, with an audit entry that
 *      does not hold the address. A subscription to anyone else is untouched.
 *   4. An unverified account's address leaves a colleague's subscription to
 *      it untouched: it may be a stranger's inbox.
 *   5. The t-809 migration's backfill sets `stoppedByErasure` on a row whose
 *      `lastError` carries an erasure's wording, and on no other (run inside a
 *      transaction that is rolled back).
 *   6. Two erasures over one row do not undo each other: while one
 *      person's redaction holds the row uncommitted, another's pre-pass
 *      waits for it (seen waiting on a lock before the first is released) and
 *      redacts the row as it was left (t-806).
 *
 * Step 2 also pins the SQL redaction to its specification (t-806): every
 * payload the erasure rewrote equals what `erasedPayload()` gives for that
 * row's payload and basis as read before the erasure. A change to either one
 * alone fails it.
 *
 * Steps 1 and 2 include events in the shape t-792 gave them, which name their
 * owner as `userId`, written for a conversation and a run that are deleted
 * before the export or the erasure reads anything. They are still found,
 * while an event in the older shape, naming only the deleted conversation, is
 * not.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-test-erasure-deliv-*` rows and removes whatever it created.
 *
 * Run with:
 *   npm run smoke:erasure-deliveries
 *   npx tsx --env-file=.env.local scripts/smoke/erasure-deliveries.ts
 */

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { eraseUser } from '@/lib/privacy/erase-user';
import { SUBJECT_DATA_SOURCES } from '@/lib/privacy/export-sources';
import {
  deliveriesNamingSubject,
  eraseSubjectFromDeliveries,
  erasedPayload,
  preRedactSubjectFromDeliveries,
  type SubjectDelivery,
} from '@/lib/privacy/delivery-payloads';
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
    const notified = await webhook('workflow_budget_exceeded', {
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
    // Their activity, already out of attempts: the DLQ's population (t-793).
    const deadLettered = await webhook(
      'chat_budget_exceeded_per_turn',
      { agentId: agent.id, conversationId: conversation.id, usedUsd: 0.5, limitUsd: 0.1 },
      'exhausted'
    );
    // Already marked by an earlier erasure of someone else it named: the mark
    // is added once, not again (t-793).
    const alreadyMarked = await webhook(
      'conversation_escalated',
      { agentId: agent.id, userId: subject.id, conversationId: conversation.id },
      'exhausted'
    );
    await prisma.aiWebhookDelivery.update({
      where: { id: alreadyMarked.id },
      data: { lastError: 'HTTP 500 (not retried: subject erased)', stoppedByErasure: true },
    });
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

    // Shapes the SQL redaction must agree with erasedPayload() on (t-806): the
    // subject as the only approver, twice over, and both owner and actor, with
    // nested and non-string values beside them.
    const soleApprover = await webhook('approval_required', {
      executionId: colleagueExecution.id,
      approverUserIds: [subject.id, subject.id],
      notificationChannel: { type: 'email', target: 'approvals@example.com' },
      timeoutMinutes: 30,
    });
    const ownerAndActor = await hookRow('workflow.started', {
      executionId: execution.id,
      userId: subject.id,
      actorUserId: subject.id,
      actorUserName: subject.name,
      iteration: 2,
      costUsd: null,
      nested: { userId: subject.id },
      approverUserIds: 'not-an-array',
    });

    // t-792: the events that named the subject only through a conversation or
    // run now carry its owner. The conversation and run they are about are
    // deleted before anything reads them (the person deleted the
    // conversation, retention pruned the run), so only the payload's own
    // `userId` still names the subject.
    const goneConversation = await prisma.aiConversation.create({
      data: { userId: subject.id, agentId: agent.id, title: `${PREFIX} deleted convo` },
    });
    const goneRun = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'failed',
        inputData: {},
        executionTrace: [],
        userId: subject.id,
      },
    });
    const ownedPerTurn = await webhook(
      'chat_budget_exceeded_per_turn',
      {
        agentId: agent.id,
        conversationId: goneConversation.id,
        userId: subject.id,
        usedUsd: 0.5,
        limitUsd: 0.1,
      },
      'failed'
    );
    const ownedNotification = await webhook('workflow_budget_exceeded', {
      workflowId: workflow.id,
      executionId: goneRun.id,
      userId: subject.id,
      body: SECRET_TEXT,
    });
    const ownedBudget = await webhook('workflow_budget_exceeded', {
      workflowId: workflow.id,
      executionId: goneRun.id,
      userId: subject.id,
      usedUsd: 2,
      limitUsd: 1,
      failedStepId: 'step-1',
    });
    const ownedFailedHook = await hookRow('workflow.failed', {
      executionId: goneRun.id,
      workflowId: workflow.id,
      userId: subject.id,
      source: 'admin-force-fail',
      errorMessage: SECRET_TEXT,
    });
    const ownedForceFailed = await hookRow('execution.force_failed', {
      executionId: goneRun.id,
      workflowId: workflow.id,
      userId: subject.id,
      actorUserId: colleague.id,
      reason: SECRET_TEXT,
      previousStatus: 'running',
    });
    // The shape written before t-792, for contrast: once the conversation is
    // gone nothing names the subject. That is the limit data-erasure.md
    // documents for older rows, and what shows the rows above are found by
    // their own `userId` rather than through the conversation or run.
    const legacyPerTurn = await webhook('chat_budget_exceeded_per_turn', {
      agentId: agent.id,
      conversationId: goneConversation.id,
      usedUsd: 0.5,
      limitUsd: 0.1,
    });
    await prisma.aiConversation.delete({ where: { id: goneConversation.id } });
    await prisma.aiWorkflowExecution.delete({ where: { id: goneRun.id } });
    const ownedWebhooks = [ownedPerTurn, ownedNotification, ownedBudget];
    const ownedHooks = [ownedFailedHook, ownedForceFailed];

    // Colleagues' email subscriptions: to the subject (typed in another case),
    // to someone else, and to the unverified account.
    const subscribe = async (emailAddress: string, createdBy = colleague.id) => {
      const sub = await prisma.aiWebhookSubscription.create({
        data: {
          channel: 'email',
          emailAddress,
          events: [`${PREFIX}-${stamp}`],
          description: `${PREFIX} subscription`,
          createdBy,
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
    // The subject's own (t-782): one to their own inbox, and one to a team
    // address — the integration that must outlive them.
    const ownToSelf = await subscribe(subject.email, subject.id);
    const ownToTeam = await subscribe(`${PREFIX}-team-${stamp}@example.com`, subject.id);

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
    check(
      ownedWebhooks.every((r) => webhookIds.includes(r.id)) &&
        ownedHooks.every((r) => hookIds.includes(r.id)),
      'every event that names its owner is exported after its conversation or run was deleted (t-792)'
    );
    check(
      !webhookIds.includes(legacyPerTurn.id),
      'an older event naming only the deleted conversation is not: the documented limit'
    );
    const exportedText = JSON.stringify([...webhookRows, ...hookRows]);
    check(exportedText.includes(SECRET_TEXT), 'the export carries what their own events said');
    check(
      !exportedText.includes(colleague.id),
      'and no colleague’s id: not the approver list, not the admin who force-failed their run'
    );

    // ── 2. Erasure redacts the payloads ──
    console.log('Erasing the subject:');
    // What the erasure will match, with each row's payload and basis as read
    // now: the input erasedPayload() is checked against afterwards.
    const before = new Map<string, SubjectDelivery>();
    for (const table of ['webhook', 'hook'] as const) {
      for (const found of await deliveriesNamingSubject(prisma, table, subject.id)) {
        if (webhookDeliveryIds.includes(found.id) || hookDeliveryIds.includes(found.id)) {
          before.set(found.id, found);
        }
      }
    }
    check(
      before.has(soleApprover.id) && before.has(ownerAndActor.id),
      'the extra shapes are matched'
    );
    const erased = await eraseUser({
      userId: subject.id,
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
    const mismatched = [...before.values()].filter(
      (found) =>
        !isDeepStrictEqual(
          row(found.id).payload,
          erasedPayload(found.payload, found.basis, subject.id)
        )
    );
    check(
      mismatched.length === 0,
      `the SQL redaction equals erasedPayload() on all ${before.size} matched rows (t-806)` +
        (mismatched.length ? `; differs on ${mismatched.map((m) => m.eventType).join(', ')}` : '')
    );
    check(
      isDeepStrictEqual(dataOf(row(soleApprover.id).payload).approverUserIds, []) &&
        'notificationChannel' in dataOf(row(soleApprover.id).payload),
      'the sole approver leaves an empty list, and an actor row keeps its channel'
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
    check(
      row(escalated.id).status === 'delivered' &&
        row(escalated.id).stoppedByErasure &&
        (row(escalated.id).lastError ?? '').includes('subject erased'),
      'and stays delivered, marked so a manual retry refuses it (t-793)'
    );
    const perTurnAfter = webhookAfter.find((r) => r.id === perTurn.id);
    check(
      perTurnAfter?.status === 'exhausted' &&
        perTurnAfter.nextRetryAt === null &&
        (perTurnAfter.lastError ?? '').includes('subject erased'),
      'an event about their conversation that was retrying is stopped'
    );
    const deadLetteredAfter = row(deadLettered.id);
    check(
      deadLetteredAfter.status === 'exhausted' && deadLetteredAfter.stoppedByErasure,
      'one already in the dead-letter queue keeps its status and is marked, so a replay refuses it (t-793)'
    );
    check(
      row(alreadyMarked.id).lastError === 'HTTP 500 (not retried: subject erased)' &&
        row(alreadyMarked.id).stoppedByErasure,
      'one an earlier erasure already marked is not marked twice'
    );
    const agentUpdatedAfter = webhookAfter.find((r) => r.id === agentUpdated.id);
    const agentUpdatedData = dataOf(row(agentUpdated.id).payload);
    check(
      agentUpdatedData.actorUserId === null &&
        !('actorUserName' in agentUpdatedData) &&
        isDeepStrictEqual(agentUpdatedData.changes, { temperature: { from: 0.2, to: 0.7 } }),
      'a change they made keeps the change and loses only them'
    );
    check(
      agentUpdatedAfter?.status === 'failed' && !agentUpdatedAfter.stoppedByErasure,
      'and keeps retrying, unmarked: the event is the org’s'
    );
    check(
      !row(unrelated.id).stoppedByErasure && !row(legacyPerTurn.id).stoppedByErasure,
      'rows that do not name the subject are not marked'
    );
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
    const ownedPerTurnAfter = row(ownedPerTurn.id);
    check(
      dataOf(ownedPerTurnAfter.payload).userId === null &&
        ownedPerTurnAfter.status === 'exhausted' &&
        (ownedPerTurnAfter.lastError ?? '').includes('subject erased'),
      'a per-turn budget event whose conversation was deleted is redacted and its retry stopped (t-792)'
    );
    check(
      !('body' in dataOf(row(ownedNotification.id).payload)),
      'a notification whose run was deleted loses the body that echoed their input'
    );
    const ownedForceFailedData = dataOf(row(ownedForceFailed.id).payload);
    check(
      ownedForceFailedData.userId === null &&
        ownedForceFailedData.actorUserId === colleague.id &&
        !('reason' in ownedForceFailedData),
      'a force-fail of a deleted run loses its owner and the free text, and keeps the admin'
    );
    check(
      isDeepStrictEqual(row(legacyPerTurn.id).payload, legacyPerTurn.payload),
      'the older event is left as it was: nothing names the subject in it'
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

    // ── 3b. The subject's own subscriptions outlive them (t-782) ──
    console.log('The subject’s own subscriptions:');
    const ownToTeamAfter = await prisma.aiWebhookSubscription.findUnique({
      where: { id: ownToTeam.id },
    });
    check(
      ownToTeamAfter !== null &&
        ownToTeamAfter.createdBy === null &&
        ownToTeamAfter.isActive &&
        ownToTeamAfter.emailAddress === ownToTeam.emailAddress,
      'one to someone else survives, active and unchanged, with no creator'
    );
    const ownToSelfAfter = await prisma.aiWebhookSubscription.findUnique({
      where: { id: ownToSelf.id },
    });
    check(
      ownToSelfAfter !== null &&
        ownToSelfAfter.createdBy === null &&
        ownToSelfAfter.emailAddress === null &&
        !ownToSelfAfter.isActive,
      'one to their own inbox survives, cleared and deactivated'
    );
    const ownAudit = await prisma.aiAdminAuditLog.findMany({
      where: { action: 'webhook_subscription.recipient_erased', entityId: ownToSelf.id },
    });
    auditIds.push(...ownAudit.map((a) => a.id));
    check(
      ownAudit.length === 1 && !JSON.stringify(ownAudit).includes(subject.id),
      'with one audit entry that does not name them as its owner'
    );

    // ── 4. An unverified address touches nothing ──
    console.log('An unverified account:');
    const erasedUnverified = await eraseUser({
      userId: unverified.id,
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

    // ── 5. The t-809 backfill marks only rows an erasure already stopped ──
    console.log('The stoppedByErasure backfill:');
    const backfill = readFileSync(
      'prisma/migrations/20261015150000_delivery_stopped_by_erasure/migration.sql',
      'utf8'
    )
      .split(';')
      .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter((statement) => statement.startsWith('UPDATE'));
    check(backfill.length === 2, 'the migration has one backfill per table');
    const lastErrors = [
      'Not retried: subject erased',
      'HTTP 500 (not retried: subject erased)',
      'Not retried: recipient erased',
      'timeout (not retried: recipient erased)',
      'HTTP 500',
      'subject erased',
      'HTTP 500 (not retried: subscription deleted)',
      null,
    ];
    const expected = [true, true, true, true, false, false, false, false];
    const rolledBack = new Error('rolled back on purpose');
    const held: { marked?: { webhook: boolean[]; hook: boolean[] } } = {};
    await prisma
      .$transaction(
        async (tx) => {
          const seeded = { webhook: [] as string[], hook: [] as string[] };
          for (const lastError of lastErrors) {
            const w = await tx.aiWebhookDelivery.create({
              data: {
                eventType: `${PREFIX}-backfill`,
                payload: {},
                status: 'exhausted',
                lastError,
              },
            });
            const h = await tx.aiEventHookDelivery.create({
              data: {
                eventType: `${PREFIX}-backfill`,
                payload: {},
                status: 'exhausted',
                lastError,
              },
            });
            seeded.webhook.push(w.id);
            seeded.hook.push(h.id);
          }
          for (const statement of backfill) await tx.$executeRawUnsafe(statement);
          const read = async (ids: string[], table: 'webhook' | 'hook') => {
            const rows =
              table === 'webhook'
                ? await tx.aiWebhookDelivery.findMany({ where: { id: { in: ids } } })
                : await tx.aiEventHookDelivery.findMany({ where: { id: { in: ids } } });
            return ids.map((id) => rows.find((r) => r.id === id)?.stoppedByErasure ?? false);
          };
          held.marked = {
            webhook: await read(seeded.webhook, 'webhook'),
            hook: await read(seeded.hook, 'hook'),
          };
          throw rolledBack;
          // The backfill statements cover whole tables, so a large dev database
          // needs longer than Prisma's 5 s default.
        },
        { timeout: 120_000 }
      )
      .catch((err: unknown) => {
        if (err !== rolledBack) throw err;
      });
    check(
      held.marked !== undefined &&
        isDeepStrictEqual(held.marked.webhook, expected) &&
        isDeepStrictEqual(held.marked.hook, expected),
      'the backfill marks both erasure wordings, whole or as a suffix, and nothing else, in both tables'
    );

    // ── 6. Two erasures over one row do not undo each other (t-806) ──
    console.log('Two erasures over one row:');
    const personX = `${PREFIX}-x-${stamp}`;
    const personY = `${PREFIX}-y-${stamp}`;
    const shared = await webhook('approval_required', {
      workflowId: workflow.id,
      approverUserIds: [personX, personY, colleague.id],
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let xRedacted: () => void = () => undefined;
    const xHolds = new Promise<void>((resolve) => {
      xRedacted = resolve;
    });
    // X's erasure redacts the row and holds it, uncommitted, until released.
    let xPid = 0;
    const xErasure = prisma.$transaction(
      async (tx) => {
        const [me] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        xPid = me.pid;
        await eraseSubjectFromDeliveries(tx, 'webhook', personX);
        xRedacted();
        await gate;
      },
      { timeout: 30_000 }
    );
    await xHolds;
    // Y's pre-pass starts while X's write is uncommitted: it must wait for it
    // and redact the row as X left it, not as it read it before.
    const yPrePass = preRedactSubjectFromDeliveries(prisma, 'webhook', personY);
    // Release X only once a session is seen blocked by X's own: released any
    // earlier, Y would read X's committed row and pass without the race. X is
    // released whatever the probe does, so a failed probe cannot leave X's
    // lock held over the cleanup below.
    const blockedByX = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i++) {
        const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM pg_stat_activity
           WHERE ${xPid}::int = ANY(pg_blocking_pids(pid))`;
        if (Number(row.n) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    let yBlocked = false;
    try {
      yBlocked = await blockedByX();
    } finally {
      release();
    }
    await xErasure;
    await yPrePass;
    const sharedAfter = await prisma.aiWebhookDelivery.findUniqueOrThrow({
      where: { id: shared.id },
    });
    check(yBlocked, 'the second erasure waited on the first’s row lock');
    check(
      isDeepStrictEqual(dataOf(sharedAfter.payload).approverUserIds, [colleague.id]),
      'the second erasure redacts the row as the first left it: neither person comes back'
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
