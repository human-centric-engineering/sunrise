/**
 * Erasure smoke: a run already executing does not send to a person erased
 * while it runs (t-841).
 *
 * A run holds its definition and input in memory from the moment it starts.
 * Proves against real Postgres, with the real engine, that it still leaves the
 * person out:
 *
 *   • **Erasure first.** The engine runs a definition read before the erasure
 *     (as an executing run holds one). Its email step to the person alone fails
 *     with `RECIPIENT_ERASED`; its email step to them and a colleague sends to
 *     the colleague only; its approval step pauses with the colleague as the
 *     only approver and no notification target — in the paused row the
 *     approval routes read.
 *   • **Send first.** A run whose email step is waiting on the person's lock
 *     (this script holds it) sends before an erasure started meanwhile, which
 *     waits for it: the step takes erasure's lock, so the two are ordered.
 *
 * The erasure-first run starts after the erasure, holding a definition built
 * before it: within `COPY_CLOCK_SKEW_MS` of its start, as a definition read
 * just before a run starts is (§122 t-886).
 *
 * And a webhook email delivery built from subscriptions read before an erasure
 * (§122 t-886), with the dispatcher's two halves (`readSubscribers`, then
 * `deliverToSubscribers`) so the erasure lands between them:
 *
 *   • **Erasure first.** The delivery is not sent: its row is stopped as
 *     erasure stops one, with the address taken off.
 *   • **Send first.** A delivery waiting on the person's lock (this script
 *     holds it) is attempted before an erasure started meanwhile, which then
 *     takes the address off the row it left.
 *   • **Re-entered.** An address erased before the subscriptions were read,
 *     and since put on a subscription again, is sent to.
 *
 * Email is switched off (the npm script blanks `RESEND_API_KEY`, and this
 * script refuses to run if it is still on), so nothing is sent; the step's
 * output says how many it left out. Everything it creates is a
 * `smoke-test-sends-*` row, removed on every path. Skips cleanly (exit 0) when
 * no database is reachable.
 *
 * Run with:
 *   npm run smoke:erasure-sends
 */

import { prisma } from '@/lib/db/client';
import { isEmailEnabled } from '@/lib/email/client';
import { eraseUser } from '@/lib/privacy/erase-user';
import { COPY_CLOCK_SKEW_MS, lockSubjects } from '@/lib/privacy/erased-subjects';
import { deliverToSubscribers, readSubscribers } from '@/lib/orchestration/webhooks/dispatcher';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import '@/lib/orchestration/engine/executors';
import { lockWaiters, sleep, until } from '@/scripts/smoke/lock-waits';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import { executionTraceSchema } from '@/lib/validations/orchestration';
import type { ExecutionTraceEntry, WorkflowDefinition } from '@/types/orchestration';

const PREFIX = 'smoke-test-sends';
const stamp = Date.now();

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

/** Run the engine to its end (or its pause) and return the run's id. */
async function run(workflowId: string, definition: WorkflowDefinition): Promise<string> {
  let executionId = '';
  for await (const event of new OrchestrationEngine().execute(
    { id: workflowId, definition },
    {},
    { userId: null }
  )) {
    if (event.type === 'workflow_started') executionId = event.executionId;
  }
  if (!executionId) throw new Error('the engine never started the run');
  return executionId;
}

async function traceOf(executionId: string): Promise<ExecutionTraceEntry[]> {
  const row = await prisma.aiWorkflowExecution.findUniqueOrThrow({
    where: { id: executionId },
    select: { executionTrace: true },
  });
  return executionTraceSchema.parse(row.executionTrace);
}

function notify(id: string, to: string | string[], next: string[]) {
  return {
    id,
    name: id,
    type: 'send_notification' as const,
    config: { channel: 'email', to, subject: 'Smoke', bodyTemplate: 'x', errorStrategy: 'skip' },
    nextSteps: next.map((targetStepId) => ({ targetStepId })),
  };
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure-sends skipped — no database reachable.');
    return;
  }
  if (isEmailEnabled()) {
    throw new Error(
      'email is configured; run through `npm run smoke:erasure-sends`, which blanks it'
    );
  }

  const userIds: string[] = [];
  const workflowIds: string[] = [];
  const receiptIds: string[] = [];
  const subscriptionIds: string[] = [];

  const person = (name: string) =>
    prisma.user
      .create({
        data: {
          name: `${PREFIX} ${name}`,
          email: `${PREFIX}-${name}-${stamp}@example.com`,
          emailVerified: true,
        },
      })
      .then((user) => {
        userIds.push(user.id);
        return user;
      });

  const workflow = async (name: string, createdBy: string) => {
    const wf = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} ${name}`,
        slug: `${PREFIX}-${name}-${stamp}`,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: { steps: [] },
        createdBy,
      },
    });
    workflowIds.push(wf.id);
    return wf.id;
  };

  try {
    const admin = await person('admin');
    const colleague = await person('colleague');

    // ── 1. Erasure first: the run's copy still names them ────────────────
    console.log('erasure first');
    const gone = await person('gone');
    const definition: WorkflowDefinition = {
      steps: [
        notify('only-them', gone.email, ['both']),
        notify('both', [gone.email, colleague.email], ['gate']),
        {
          id: 'gate',
          name: 'gate',
          type: 'human_approval',
          config: {
            prompt: 'Approve?',
            approverUserIds: [gone.id, colleague.id],
            notificationChannel: { type: 'email', target: gone.email },
          },
          nextSteps: [],
        },
      ],
      entryStepId: 'only-them',
      errorStrategy: 'fail',
    };
    const erasure = await eraseUser({
      userId: gone.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    receiptIds.push(erasure.receiptId);

    const executionId = await run(await workflow('erasure-first', admin.id), definition);
    const trace = await traceOf(executionId);
    const step = (id: string) => trace.find((e) => e.stepId === id);

    check(
      step('only-them')?.status !== 'completed' &&
        step('only-them')?.error?.includes('erased') === true,
      'an email step naming only them sends nothing and fails as RECIPIENT_ERASED'
    );
    const both = step('both')?.output as { sent?: unknown; recipientsLeftOut?: unknown };
    check(
      both?.sent === true && both.recipientsLeftOut === 1,
      'an email step naming them and a colleague sends, leaving them out'
    );
    const gate = step('gate');
    const row = await prisma.aiWorkflowExecution.findUniqueOrThrow({
      where: { id: executionId },
      select: { status: true },
    });
    check(row.status === 'paused_for_approval', 'the run paused at its approval step');
    check(
      JSON.stringify((gate?.output as { approverUserIds?: unknown }).approverUserIds) ===
        JSON.stringify([colleague.id]),
      'the paused row names the colleague as the only approver'
    );
    const gateText = JSON.stringify(gate).toLowerCase();
    check(
      !gateText.includes(gone.id) && !gateText.includes(gone.email.toLowerCase()),
      "the approval step's entry does not name them, in its config or its payload"
    );
    // Nor do the earlier steps' entries, whose config the run held from
    // before the erasure (t-843).
    const traceText = JSON.stringify(trace).toLowerCase();
    check(
      !traceText.includes(gone.id) && !traceText.includes(gone.email.toLowerCase()),
      'no entry in the trace names them'
    );

    // ── 2. Send first: an erasure waits for the step's send ─────────────
    console.log('send first');
    const racer = await person('racer');
    const racerFlow = await workflow('send-first', admin.id);
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the person's lock, so the step queues on it.
    const hold = prisma.$transaction(
      async (tx) => {
        await lockSubjects(tx, { addresses: [racer.email] });
        await released;
      },
      { timeout: 60_000 }
    );
    hold.catch(() => undefined);
    let erasureSettledAt = 0;
    try {
      await sleep(100);
      const waitersBefore = await lockWaiters();
      const sending = run(racerFlow, {
        steps: [notify('to-racer', racer.email, [])],
        entryStepId: 'to-racer',
        errorStrategy: 'fail',
      });
      await until(async () => (await lockWaiters()) > waitersBefore, 10_000, 'the step to queue');
      check(true, "the step waits on the person's erasure lock");

      const racerErasure = eraseUser({
        userId: racer.id,
        actorUserId: admin.id,
        reason: 'admin_action',
      }).then((result) => {
        erasureSettledAt = Date.now();
        receiptIds.push(result.receiptId);
        return result;
      });
      await sleep(300);
      release();

      const racerRun = await sending;
      await racerErasure;
      const racerTrace = await traceOf(racerRun);
      // Stamped when the step returned, after its send's transaction committed.
      const sentAt = Date.parse(racerTrace[0]?.completedAt ?? '');
      const sent = racerTrace[0]?.output as { sent?: unknown; recipientsLeftOut?: unknown };
      check(
        sent?.sent === true && sent.recipientsLeftOut === undefined,
        'the step queued first sends to them, before the erasure'
      );
      check(erasureSettledAt > sentAt, 'the erasure finished after the send');
    } finally {
      release();
      await hold.catch(() => undefined);
    }

    // ── 3. A webhook email built from subscriptions read before the erasure ──
    const EVENT = 'budget_exceeded';
    const emailing = async (address: string) => {
      const sub = await prisma.aiWebhookSubscription.create({
        data: {
          orgId: INSTALL_ORG_ID,
          channel: 'email',
          emailAddress: address,
          events: [EVENT],
          description: `${PREFIX} ${stamp}`,
          createdBy: admin.id,
        },
      });
      subscriptionIds.push(sub.id);
      return sub.id;
    };
    // This script's subscription only: a development database may hold real
    // ones for the same event, which must not be sent to.
    const readOnly = async (subscriptionId: string) => {
      const read = await readSubscribers(EVENT, { agentId: PREFIX });
      return { ...read, subscriptions: read.subscriptions.filter((s) => s.id === subscriptionId) };
    };
    const deliveryOf = (subscriptionId: string) =>
      prisma.aiWebhookDelivery.findFirstOrThrow({
        where: { subscriptionId },
        select: {
          status: true,
          stoppedByErasure: true,
          destination: true,
          lastError: true,
          attempts: true,
        },
      });

    console.log('webhook email: erasure first');
    const subscriber = await person('subscriber');
    const subId = await emailing(subscriber.email);
    const copy = await readOnly(subId);
    check(copy.subscriptions.length === 1, 'the dispatch read the subscription emailing them');
    const subscriberErasure = await eraseUser({
      userId: subscriber.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    receiptIds.push(subscriberErasure.receiptId);
    await deliverToSubscribers(EVENT, { agentId: PREFIX }, copy);
    const stopped = await deliveryOf(subId);
    check(
      stopped.stoppedByErasure && stopped.status === 'exhausted' && stopped.attempts === 0,
      'the delivery built from the earlier copy is stopped, never attempted'
    );
    check(stopped.destination === '[erased]', 'and its row does not keep the address');
    check(
      stopped.lastError?.includes('recipient erased') === true,
      'its last error says the recipient was erased (not a failed send)'
    );

    console.log('webhook email: send first');
    const raced = await person('raced');
    const racedSub = await emailing(raced.email);
    let releaseSub = (): void => undefined;
    const subReleased = new Promise<void>((resolve) => {
      releaseSub = resolve;
    });
    const holdSub = prisma.$transaction(
      async (tx) => {
        await lockSubjects(tx, { addresses: [raced.email] });
        await subReleased;
      },
      { timeout: 60_000 }
    );
    holdSub.catch(() => undefined);
    try {
      await sleep(100);
      const waitersBefore = await lockWaiters();
      const delivering = readOnly(racedSub).then((read) =>
        deliverToSubscribers(EVENT, { agentId: PREFIX }, read)
      );
      await until(
        async () => (await lockWaiters()) > waitersBefore,
        10_000,
        'the delivery to queue'
      );
      check(true, "the delivery waits on the person's erasure lock");
      const racedErasure = eraseUser({
        userId: raced.id,
        actorUserId: admin.id,
        reason: 'admin_action',
      });
      await sleep(300);
      releaseSub();
      await delivering;
      receiptIds.push((await racedErasure).receiptId);
      const attempted = await deliveryOf(racedSub);
      // What shows it went first is that it was attempted at all. Its outcome
      // is written after its locks are let go, so the erasure may stop the row
      // in between, as it stops any attempt in flight (t-793).
      check(attempted.attempts === 1, 'the delivery queued first is attempted, before the erasure');
      check(
        attempted.destination === '[erased]',
        'and the erasure, waiting for it, then took the address off its row'
      );
    } finally {
      releaseSub();
      await holdSub.catch(() => undefined);
    }

    console.log('webhook email: re-entered after an older erasure');
    const returning = await person('returning');
    const returningErasure = await eraseUser({
      userId: returning.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    receiptIds.push(returningErasure.receiptId);
    // An erasure from before the margin: the copy below cannot predate it.
    await prisma.dataErasureReceipt.update({
      where: { id: returningErasure.receiptId },
      data: { erasedAt: new Date(Date.now() - COPY_CLOCK_SKEW_MS - 60_000) },
    });
    const backSub = await emailing(returning.email);
    await deliverToSubscribers(EVENT, { agentId: PREFIX }, await readOnly(backSub));
    const reentered = await deliveryOf(backSub);
    // Email is off, so the attempt itself fails, terminally: it was attempted.
    check(
      !reentered.stoppedByErasure &&
        reentered.attempts === 1 &&
        reentered.lastError?.includes('not configured') === true,
      'an address put back on a subscription after its erasure is sent to'
    );

    console.log('\n✓ smoke:erasure-sends passed');
  } finally {
    await prisma.aiWebhookDelivery
      .deleteMany({ where: { subscriptionId: { in: subscriptionIds } } })
      .catch(() => undefined);
    await prisma.aiWebhookSubscription
      .deleteMany({ where: { id: { in: subscriptionIds } } })
      .catch(() => undefined);
    await prisma.aiWorkflow
      .deleteMany({ where: { id: { in: workflowIds } } })
      .catch(() => undefined);
    await prisma.dataErasureReceipt
      .deleteMany({ where: { id: { in: receiptIds } } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' }).catch(async (err) => {
  console.error('\n✗ smoke:erasure-sends failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
