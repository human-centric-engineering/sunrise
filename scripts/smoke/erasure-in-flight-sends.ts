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
import { lockSubjects } from '@/lib/privacy/erased-subjects';
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

    console.log('\n✓ smoke:erasure-sends passed');
  } finally {
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
