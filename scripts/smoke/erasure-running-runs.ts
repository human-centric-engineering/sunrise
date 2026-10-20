/**
 * Erasure smoke: a run still executing does not write a person erased while
 * it runs back into its row (t-843).
 *
 * A run holds its input, step outputs and trace in memory and writes the trace
 * whole after every step. Proves against real Postgres, with the real engine,
 * that what the erasure removed stays removed:
 *
 *   • **Erasure between steps.** A run whose input names the person has
 *     written a step naming them; it is erased while the next step runs. The
 *     erasure redacts the row, and the run's next writes leave them out of
 *     `executionTrace`, `inputData`, `outputData` — and of what a step started
 *     after the erasure reads.
 *   • **A write queued behind the erasure.** A transaction shaped like the
 *     erasure's holds the run's row, writes a receipt and commits; the run's
 *     write, queued behind it on the row, sees the receipt and leaves them
 *     out. The receipt is for a person with no account, so no user is erased.
 *   • **A write while the erasure is open.** The run names the person only
 *     from its definition, held in memory, and writes and finishes while the
 *     erasure's transaction is open (an erasure hook holds it) — before any
 *     receipt is visible, on a row the erasure's pass did not lock. The
 *     erasure's pass after its commit takes them out.
 *
 * Steps are a stand-in `llm_call` that waits on a gate the script opens, so no
 * provider is called. Everything it creates is a `smoke-test-running-*` row,
 * removed on every path. Skips cleanly (exit 0) when no database is reachable.
 *
 * Run with:
 *   npm run smoke:erasure-running
 */

import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { eraseUser } from '@/lib/privacy/erase-user';
import { registerErasureCleanupHook } from '@/lib/privacy/erasure-hooks';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import '@/lib/orchestration/engine/executors';
import { lockWaiters, sleep, until } from '@/scripts/smoke/lock-waits';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import type { WorkflowDefinition } from '@/types/orchestration';

const PREFIX = 'smoke-test-running';
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

/** A gate a step waits on until the script opens it. */
interface Gate {
  reached: boolean;
  open: () => void;
  opened: Promise<void>;
}
const gates = new Map<string, Gate>();
function gate(name: string): Gate {
  let g = gates.get(name);
  if (!g) {
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    g = { reached: false, open, opened };
    gates.set(name, g);
  }
  return g;
}

/** What each step was handed of an earlier step's output, by step id. */
const seen = new Map<string, unknown>();

// The stand-in step: waits on its gate (if any), records what it can see of
// the step before it, and outputs its `say` config and the run's `to` input.
registerStepType('llm_call', async (step, ctx) => {
  const config = step.config as { gate?: string; say?: unknown; reads?: string };
  if (config.reads) seen.set(step.id, ctx.stepOutputs[config.reads]);
  if (config.gate) {
    const g = gate(config.gate);
    g.reached = true;
    await g.opened;
  }
  return {
    output: { say: config.say ?? null, to: ctx.inputData.to ?? null },
    tokensUsed: 0,
    costUsd: 0,
  };
});

function step(id: string, config: Record<string, unknown>, next: string[]) {
  return {
    id,
    name: id,
    type: 'llm_call' as const,
    config,
    nextSteps: next.map((targetStepId) => ({ targetStepId })),
  };
}

/** Start the engine on `definition`; resolves with the run's id once it ends. */
function start(
  workflowId: string,
  definition: WorkflowDefinition,
  input: Record<string, unknown>,
  ownerId: string
): { executionId: Promise<string>; done: Promise<void> } {
  let resolveId = (_id: string): void => undefined;
  const executionId = new Promise<string>((resolve) => {
    resolveId = resolve;
  });
  const done = (async () => {
    for await (const event of new OrchestrationEngine().execute(
      { id: workflowId, definition },
      input,
      { userId: ownerId }
    )) {
      if (event.type === 'workflow_started') resolveId(event.executionId);
    }
  })();
  return { executionId, done };
}

async function rowOf(executionId: string) {
  return prisma.aiWorkflowExecution.findUniqueOrThrow({
    where: { id: executionId },
    select: {
      status: true,
      inputData: true,
      executionTrace: true,
      outputData: true,
      errorMessage: true,
    },
  });
}

/** Whether any of the four columns erasure redacts names the address or the id. */
function names(row: Awaited<ReturnType<typeof rowOf>>, address: string, id: string): boolean {
  const text = JSON.stringify([
    row.inputData,
    row.executionTrace,
    row.outputData,
    row.errorMessage,
  ]).toLowerCase();
  return text.includes(address.toLowerCase()) || text.includes(id.toLowerCase());
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure-running skipped — no database reachable.');
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

    // ── 1. Erasure between steps ─────────────────────────────────────────
    console.log('erasure between steps');
    const gone = await person('gone');
    const first = start(
      await workflow('between', admin.id),
      {
        steps: [
          step('a', { say: `approver ${gone.id}` }, ['b']),
          step('b', { gate: 'between' }, ['c']),
          step('c', { reads: 'a' }, []),
        ],
        entryStepId: 'a',
        errorStrategy: 'fail',
      },
      { to: gone.email, approverUserIds: [gone.id] },
      admin.id
    );
    const firstId = await first.executionId;
    await until(() => gate('between').reached, 10_000, 'step b to start');
    check(
      names(await rowOf(firstId), gone.email, gone.id),
      "the run's row names them before the erasure (step a's entry, the input)"
    );
    const erasure = await eraseUser({
      userId: gone.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    receiptIds.push(erasure.receiptId);
    check(!names(await rowOf(firstId), gone.email, gone.id), 'the erasure redacted the row');
    gate('between').open();
    await first.done;
    const firstRow = await rowOf(firstId);
    check(firstRow.status === 'completed', 'the run finished');
    check(
      !names(firstRow, gone.email, gone.id),
      "the run's writes after the erasure left them out of its trace, input and output"
    );
    check(
      JSON.stringify(seen.get('c')) ===
        JSON.stringify({ say: 'approver [erased]', to: '[erased]' }),
      "a step started after the erasure read step a's output redacted"
    );

    // ── 2. A write queued behind the erasure ─────────────────────────────
    console.log('a write queued behind the erasure');
    // A person with no account: the receipt stands for their erasure.
    const ghostId = `cmsmokeghost${stamp}`;
    const ghost = `${PREFIX}-ghost-${stamp}@example.com`;
    const second = start(
      await workflow('queued', admin.id),
      {
        steps: [step('a', { gate: 'queued', say: ghost }, ['b']), step('b', {}, [])],
        entryStepId: 'a',
        errorStrategy: 'fail',
      },
      { to: ghostId },
      admin.id
    );
    const secondId = await second.executionId;
    await until(() => gate('queued').reached, 10_000, 'step a to start');
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = prisma.$transaction(
      async (tx) => {
        // The erasure's run pass: hold the row, take them out, write the receipt.
        await tx.$executeRaw`SELECT 1 FROM ai_workflow_execution WHERE id = ${secondId} FOR NO KEY UPDATE`;
        await tx.aiWorkflowExecution.update({
          where: { id: secondId },
          data: { inputData: { to: '[erased]' } },
        });
        const receipt = await tx.dataErasureReceipt.create({
          data: {
            subjectUserId: ghostId,
            subjectEmailHash: createHash('sha256').update(ghost).digest('hex'),
            reason: 'admin_action',
            metadata: { addressVerified: true },
          },
        });
        receiptIds.push(receipt.id);
        locked();
        await released;
      },
      { timeout: 60_000 }
    );
    hold.catch(() => undefined);
    try {
      await isLocked;
      const waitersBefore = await lockWaiters();
      gate('queued').open();
      await until(
        async () => (await lockWaiters()) > waitersBefore,
        10_000,
        "the run's write to queue"
      );
      check(true, "the run's write waits on the row the erasure holds");
      await sleep(200);
      release();
      await hold;
      await second.done;
    } finally {
      release();
      await hold.catch(() => undefined);
    }
    const secondRow = await rowOf(secondId);
    check(secondRow.status === 'completed', 'the run finished');
    check(
      !names(secondRow, ghost, ghostId),
      'the write queued behind the erasure saw its receipt and left them out'
    );

    // ── 3. A write while the erasure is open ─────────────────────────────
    console.log('a write while the erasure is open');
    const late = await person('late');
    const third = start(
      await workflow('open', admin.id),
      {
        // Only the definition names them: nothing in the row does until step a writes.
        steps: [step('a', { gate: 'open', say: late.email }, [])],
        entryStepId: 'a',
        errorStrategy: 'fail',
      },
      {},
      admin.id
    );
    const thirdId = await third.executionId;
    await until(() => gate('open').reached, 10_000, 'step a to start');
    let hookEntered = false;
    let letErasureCommit = (): void => undefined;
    const commitAllowed = new Promise<void>((resolve) => {
      letErasureCommit = resolve;
    });
    registerErasureCleanupHook({
      name: `${PREFIX}-hold-${stamp}`,
      // Runs inside the erasure's transaction, after its run pass and before
      // its receipt: holds it open while the run writes.
      scrubInTransaction: async ({ userId }) => {
        if (userId !== late.id) return;
        hookEntered = true;
        await commitAllowed;
      },
    });
    const lateErasure = eraseUser({
      userId: late.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    lateErasure.catch(() => undefined);
    try {
      await until(() => hookEntered, 20_000, "the erasure's transaction to reach its hook");
      gate('open').open();
      await third.done;
      check(
        names(await rowOf(thirdId), late.email, late.id),
        'the run wrote them and finished while the erasure was open, with no receipt yet to see'
      );
    } finally {
      letErasureCommit();
    }
    const lateResult = await lateErasure;
    receiptIds.push(lateResult.receiptId);
    const thirdRow = await rowOf(thirdId);
    check(thirdRow.status === 'completed', 'the run finished');
    check(
      !names(thirdRow, late.email, late.id),
      "the erasure's pass after its commit took them out"
    );

    console.log('\n✓ smoke:erasure-running passed');
  } finally {
    for (const g of gates.values()) g.open();
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
  console.error('\n✗ smoke:erasure-running failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
