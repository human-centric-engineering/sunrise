/**
 * Erasure smoke: an action on a run racing an erasure never writes the person
 * back (§122 t-901).
 *
 * Approve, reject and retry-step read a run's trace and write it back whole.
 * Each now does both in one transaction under the run's row lock, which
 * erasure takes too. Proves against real Postgres, with the real functions,
 * that the person is gone afterwards whichever gets the row first:
 *
 *   • **Action first.** This script holds the run's row; the action queues on
 *     it, then an erasure queues behind the action. Let go, the action writes
 *     its copy, naming the person, and the erasure then redacts what it wrote.
 *   • **Erasure first.** The same, with the erasure queued first: it redacts
 *     the run, and the action, which reads only once it has the row, reads and
 *     writes the redacted run.
 *
 * The runs are rows this script writes directly — a paused approval naming the
 * person as an approver and its notification target, a failed run whose
 * earlier step names them — so no engine or provider runs. Everything it
 * creates is a `smoke-test-run-actions-*` row, removed on every path. Skips
 * cleanly (exit 0) when no database is reachable.
 *
 * What it cannot show is the old failure itself: an action that read before
 * an erasure and wrote after the erasure had finished. Staging that needs a
 * stall between the read and the write that does not also hold the row — and
 * anything that stalls the write on the row stalls the erasure too. So this
 * passes with the lock removed as well (measured): in both orders staged here
 * erasure's own later passes reach the action's write. It proves the outcome
 * under real locking; `run-row-lock.test.ts` and `approval-actions.test.ts`
 * hold the order the fix depends on (lock, then read).
 *
 * Run with:
 *   npm run smoke:erasure-run-actions
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { eraseUser } from '@/lib/privacy/erase-user';
import { executeApproval, executeRejection } from '@/lib/orchestration/approval-actions';
import { prepareRetryStep } from '@/lib/orchestration/retry-step';
import { lockRunRow } from '@/lib/orchestration/engine/run-row-lock';
import { lockWaiters, sleep, until } from '@/scripts/smoke/lock-waits';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

const PREFIX = 'smoke-test-run-actions';
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

/** A trace entry, as the engine writes one. */
function entry(
  stepId: string,
  status: 'completed' | 'failed' | 'awaiting_approval',
  output: unknown
): Prisma.InputJsonObject {
  return {
    stepId,
    stepType: status === 'awaiting_approval' ? 'human_approval' : 'llm_call',
    label: stepId,
    status,
    output: output as Prisma.InputJsonValue,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    ...(status === 'failed' ? { error: 'boom' } : {}),
  };
}

type Action = 'approve' | 'reject' | 'retry-step';

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure-run-actions skipped — no database reachable.');
    return;
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

  try {
    const admin = await person('admin');
    const colleague = await person('colleague');
    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} ${stamp}`,
        slug: `${PREFIX}-${stamp}`,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: { steps: [] },
        createdBy: admin.id,
      },
    });
    workflowIds.push(workflow.id);

    /** A run, owned by the admin, that names `gone` the way `action` reads it. */
    const runFor = async (action: Action, gone: { id: string; email: string }) => {
      const trace =
        action === 'retry-step'
          ? [entry('notify', 'completed', { to: gone.email }), entry('next', 'failed', null)]
          : [
              entry('gate', 'awaiting_approval', {
                prompt: 'Approve?',
                approverUserIds: [gone.id, colleague.id],
                notificationChannel: { type: 'email', target: gone.email },
              }),
            ];
      const run = await prisma.aiWorkflowExecution.create({
        data: {
          workflowId: workflow.id,
          status: action === 'retry-step' ? 'failed' : 'paused_for_approval',
          inputData: {},
          executionTrace: trace,
          currentStep: action === 'retry-step' ? 'next' : 'gate',
          userId: admin.id,
          startedAt: new Date(),
        },
      });
      return run.id;
    };

    const act = (action: Action, executionId: string): Promise<unknown> => {
      if (action === 'approve') return executeApproval(executionId, { actorLabel: 'smoke' });
      if (action === 'reject') {
        return executeRejection(executionId, { reason: 'smoke', actorLabel: 'smoke' });
      }
      return prepareRetryStep(executionId, 'next', () => true);
    };

    /** Hold the run's row until `release()`. */
    const hold = (executionId: string) => {
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = prisma.$transaction(
        async (tx) => {
          // The very lock the actions take, so a change to it changes this too.
          await lockRunRow(tx, executionId);
          await released;
        },
        { timeout: 120_000 }
      );
      held.catch(() => undefined);
      return { held, release };
    };

    for (const action of ['reject', 'approve', 'retry-step'] as const) {
      for (const order of ['action first', 'erasure first'] as const) {
        console.log(`${action}: ${order}`);
        const gone = await person(`${action}-${order === 'action first' ? 'a' : 'e'}`);
        const executionId = await runFor(action, gone);
        const { held, release } = hold(executionId);
        try {
          await sleep(100);
          const erase = () =>
            eraseUser({ userId: gone.id, actorUserId: admin.id, reason: 'admin_action' }).then(
              (r) => {
                receiptIds.push(r.receiptId);
              }
            );
          const baseline = await lockWaiters();
          let waiters = baseline;
          const first = order === 'action first' ? act(action, executionId) : erase();
          await until(async () => (await lockWaiters()) > waiters, 15_000, 'the first to queue');
          waiters = await lockWaiters();
          const second = order === 'action first' ? erase() : act(action, executionId);
          await until(async () => (await lockWaiters()) > waiters, 15_000, 'the second to queue');
          // Both are now waiting on the row this script holds.
          check(
            (await lockWaiters()) >= baseline + 2,
            `the ${order === 'action first' ? 'action' : 'erasure'} queued on the run’s row first, then the other`
          );
          release();
          await Promise.all([first, second]);
        } finally {
          release();
          await held.catch(() => undefined);
        }

        const row = await prisma.aiWorkflowExecution.findUniqueOrThrow({
          where: { id: executionId },
          select: { status: true, executionTrace: true, errorMessage: true },
        });
        const text = JSON.stringify(row).toLowerCase();
        const expected =
          action === 'approve' ? 'pending' : action === 'reject' ? 'cancelled' : 'pending';
        check(row.status === expected, `the ${action} went through (status ${row.status})`);
        check(
          !text.includes(gone.id.toLowerCase()) && !text.includes(gone.email.toLowerCase()),
          'the run does not name the erased person afterwards'
        );
      }
    }

    console.log('\n✓ smoke:erasure-run-actions passed');
  } finally {
    await prisma.aiWorkflowExecution
      .deleteMany({ where: { workflowId: { in: workflowIds } } })
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
  console.error('\n✗ smoke:erasure-run-actions failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
