/**
 * Erasure smoke: a writer that read before an erasure cannot write the person
 * back (t-805).
 *
 * Proves against real Postgres what the mocked unit tests cannot: that the
 * advisory lock erasure and the writers share really orders them, in both
 * directions.
 *
 *   • **Writer first.** A writer holds the lock for the subject's address and
 *     writes it onto a subscription, slowly. An erasure started meanwhile waits
 *     for it, then sees the committed write and strips it — the address does
 *     not survive.
 *   • **Erasure first.** A write making the all-time check is refused once
 *     the erasure has committed; a workflow draft naming them only as an
 *     approver id saves with the id stripped. The config routes and the
 *     workflow builder refuse a stale save by version instead (t-899, t-900):
 *     `smoke:erasure-stale-saves`.
 *   • **Re-registered.** Someone who signs up again with the erased address,
 *     and verifies it, may be named again.
 *   • **Unverified.** An unverified account's erased address is not refused:
 *     erasure never matched it, and it may be a stranger's inbox.
 *   • **A scheduler tick** (t-839), a writer like the rest, in both orders.
 *     *Tick first:* a real `processDueSchedules()` takes the person's lock
 *     for a schedule whose template emails them, then stalls just before its
 *     run lands (this script holds the workflow row, which the run's insert
 *     needs). An erasure meanwhile waits for it, then redacts the run.
 *     Without the tick's lock the erasure finishes first and the run then
 *     lands naming the person. *Erasure first:* a tick holding a copy of the
 *     template from before the erasure makes its run with the address
 *     blanked. Skipped when other schedules are due, since a tick would fire
 *     them too. The workflows are deliberately unrunnable, so the tick marks
 *     its runs failed and sends nothing.
 *
 * Everything it creates is a `smoke-test-writers-*` row, removed on every path.
 * Skips cleanly (exit 0) when no database is reachable.
 *
 * Run with:
 *   npm run smoke:erasure-writers
 */

import { prisma } from '@/lib/db/client';
import { ValidationError } from '@/lib/api/errors';
import { eraseUser } from '@/lib/privacy/erase-user';
import { findErasedSubjects } from '@/lib/privacy/erased-subjects';
import { saveDraft } from '@/lib/orchestration/workflows/version-service';
import { lockedVersion } from '@/lib/orchestration/config-versions';
import { processDueSchedules } from '@/lib/orchestration/scheduling';
import { holdWorkflowRow, lockWaiters, sleep, until } from '@/scripts/smoke/lock-waits';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

/**
 * A writer's all-time check, as the scheduler still makes one: under
 * erasure's lock, refuse a write that names anyone erased. The config routes
 * and the workflow builder moved off it to versioned saves (t-899, t-900,
 * `smoke:erasure-stale-saves`); what these cases prove is the lock and the
 * matching underneath, which those writers still share.
 */
async function refuseIfErased(
  tx: Parameters<typeof findErasedSubjects>[0],
  addresses: string[]
): Promise<void> {
  const erased = await findErasedSubjects(tx, { addresses });
  if (erased.addresses.length > 0) {
    throw new ValidationError('A recipient belongs to a person whose data was erased');
  }
}

const PREFIX = 'smoke-test-writers';
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

async function refused(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return false;
  } catch (err) {
    if (err instanceof ValidationError) return true;
    throw err;
  }
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure-writers skipped — no database reachable.');
    return;
  }

  const userIds: string[] = [];
  const subscriptionIds: string[] = [];
  const workflowIds: string[] = [];
  const scheduleIds: string[] = [];
  const receiptIds: string[] = [];

  const person = (name: string, emailVerified: boolean, email?: string) =>
    prisma.user
      .create({
        data: {
          name: `${PREFIX} ${name}`,
          email: email ?? `${PREFIX}-${name}-${stamp}@example.com`,
          emailVerified,
        },
      })
      .then((user) => {
        userIds.push(user.id);
        return user;
      });

  try {
    const admin = await person('admin', true);

    // ── 1. Writer first: the erasure waits, then strips what it wrote ─────
    console.log('writer first');
    const early = await person('early', true);
    const sub = await prisma.aiWebhookSubscription.create({
      data: {
        channel: 'email',
        emailAddress: `${PREFIX}-team-${stamp}@example.com`,
        events: [`${PREFIX}-${stamp}`],
        createdBy: admin.id,
        orgId: INSTALL_ORG_ID,
      },
    });
    subscriptionIds.push(sub.id);

    let writerCommittedAt = 0;
    const writer = prisma.$transaction(async (tx) => {
      await refuseIfErased(tx, [early.email]);
      await tx.aiWebhookSubscription.update({
        where: { id: sub.id },
        data: { emailAddress: early.email },
      });
      // Hold the lock long enough for the erasure to arrive and queue behind it.
      await sleep(800);
      writerCommittedAt = Date.now();
    });
    await sleep(150);
    let erasureFinishedAt = 0;
    const erasure = eraseUser({
      userId: early.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    }).then((r) => {
      erasureFinishedAt = Date.now();
      return r;
    });
    const [, earlyResult] = await Promise.all([writer, erasure]);
    receiptIds.push(earlyResult.receiptId);
    userIds.splice(userIds.indexOf(early.id), 1);
    // No timing assertion: an erasure slower than the writer's sleep would
    // pass one without any lock. The strip below is the proof — without the
    // shared lock the erasure reads the row before the write commits and the
    // address survives (checked by disabling the lock: this assertion fails).
    check(writerCommittedAt > 0 && erasureFinishedAt > 0, 'both the writer and the erasure ran');
    const subAfter = await prisma.aiWebhookSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    check(
      subAfter.emailAddress === null && !subAfter.isActive,
      'the erasure stripped the address the writer had just committed'
    );
    const receipt = await prisma.dataErasureReceipt.findUniqueOrThrow({
      where: { id: earlyResult.receiptId },
    });
    check(
      typeof receipt.metadata === 'object' &&
        receipt.metadata !== null &&
        !Array.isArray(receipt.metadata) &&
        receipt.metadata.addressVerified === true,
      'the receipt records that the address was verified'
    );

    // ── 2. Erasure first: a stale copy is refused ─────────────────────────
    console.log('erasure first');
    const late = await person('late', true);
    const staleAddress = ` ${late.email.toUpperCase()} `;
    const def = workflowDefinitionSchema.parse({
      steps: [
        {
          id: 'ap',
          name: 'Approve',
          type: 'human_approval',
          config: { prompt: 'OK?', approverUserIds: [late.id] },
          nextSteps: [],
        },
      ],
      entryStepId: 'ap',
      errorStrategy: 'fail',
    });
    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} workflow`,
        slug: `${PREFIX}-workflow-${stamp}`,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: { steps: [] },
        createdBy: admin.id,
      },
    });
    workflowIds.push(workflow.id);

    const lateResult = await eraseUser({
      userId: late.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    receiptIds.push(lateResult.receiptId);
    userIds.splice(userIds.indexOf(late.id), 1);

    check(
      await refused(() => prisma.$transaction((tx) => refuseIfErased(tx, [staleAddress]))),
      'a write holding their address (another case, padded) is refused'
    );
    // Loaded now, so the save is not stale: only the approver id is at issue.
    const loadedAt = await prisma.$transaction((tx) =>
      lockedVersion(tx, { kind: 'workflow-definition', id: workflow.id })
    );
    await saveDraft({
      workflowId: workflow.id,
      definition: def,
      loadedAt: [loadedAt],
      userId: admin.id,
    });
    const strippedDraft = await prisma.aiWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
    check(
      !JSON.stringify(strippedDraft.draftDefinition).includes(late.id),
      'a builder tab naming them as an approver saves, with their id stripped'
    );

    // ── 3. Re-registered and verified: may be named again ─────────────────
    console.log('re-registered');
    await person('late-again', true, late.email);
    check(
      !(await refused(() => prisma.$transaction((tx) => refuseIfErased(tx, [late.email])))),
      'a verified account holding the address again lifts the refusal'
    );

    // ── 4. Unverified: never refused ──────────────────────────────────────
    console.log('unverified');
    const unverified = await person('unverified', false);
    const unverifiedResult = await eraseUser({
      userId: unverified.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    receiptIds.push(unverifiedResult.receiptId);
    userIds.splice(userIds.indexOf(unverified.id), 1);
    check(
      !(await refused(() => prisma.$transaction((tx) => refuseIfErased(tx, [unverified.email])))),
      'an unverified account’s address is not refused'
    );

    // ── 5. A scheduler tick that read before the erasure (t-839) ──────────
    console.log('scheduler tick');
    const otherDue = await prisma.aiWorkflowSchedule.count({
      where: { isEnabled: true, nextRunAt: { lte: new Date() } },
    });
    if (otherDue > 0) {
      console.log(
        `  – skipped: ${otherDue} schedule(s) already due here, and a tick would run them`
      );
    } else {
      /** A due schedule whose template emails `to`, on an unrunnable workflow of its own. */
      const scheduleEmailing = async (to: string, name: string) => {
        // No entryStepId, so the tick creates its run and then marks it failed
        // rather than starting the engine: nothing is sent.
        const unrunnable = {
          steps: [
            {
              id: 'n',
              name: 'Notify',
              type: 'send_notification',
              config: {
                channel: 'email',
                to: '{{input.userEmail}}',
                subject: 'Hi',
                bodyTemplate: 'x',
              },
              nextSteps: [],
            },
          ],
          errorStrategy: 'fail',
        };
        check(
          !workflowDefinitionSchema.safeParse(unrunnable).success,
          `the ${name} workflow cannot start the engine`
        );
        const wf = await prisma.aiWorkflow.create({
          data: {
            name: `${PREFIX} ${name} workflow`,
            slug: `${PREFIX}-${name}-${stamp}`,
            description: 'smoke',
            orgId: INSTALL_ORG_ID,
            draftDefinition: { steps: [] },
            createdBy: admin.id,
          },
        });
        workflowIds.push(wf.id);
        const version = await prisma.aiWorkflowVersion.create({
          data: { workflowId: wf.id, version: 1, snapshot: unrunnable, createdBy: admin.id },
        });
        await prisma.aiWorkflow.update({
          where: { id: wf.id },
          data: { publishedVersionId: version.id },
        });
        const schedule = await prisma.aiWorkflowSchedule.create({
          data: {
            workflowId: wf.id,
            name: `${PREFIX} ${name} schedule`,
            cronExpression: '0 0 1 1 *',
            inputTemplate: { userEmail: to },
            isEnabled: true,
            nextRunAt: new Date(Date.now() - 60_000),
            createdBy: admin.id,
            orgId: INSTALL_ORG_ID,
          },
        });
        scheduleIds.push(schedule.id);
        return { workflowId: wf.id, scheduleId: schedule.id };
      };
      const runInputOf = async (workflowId: string) => {
        const runs = await prisma.aiWorkflowExecution.findMany({ where: { workflowId } });
        check(runs.length === 1, 'the tick created one run');
        return JSON.stringify(runs[0].inputData).toLowerCase();
      };

      // Tick first: the erasure waits for the run, then redacts it.
      const scheduled = await person('scheduled', true);
      const first = await scheduleEmailing(scheduled.email, 'tick-first');
      const waitersBefore = await lockWaiters();
      const hold = holdWorkflowRow(first.workflowId, 60_000);
      let erasureSettled = false;
      try {
        await sleep(100);
        const tick = processDueSchedules();
        await until(async () => (await lockWaiters()) > waitersBefore, 10_000, 'the tick to stall');
        const erasure = eraseUser({
          userId: scheduled.id,
          actorUserId: admin.id,
          reason: 'admin_action',
        }).finally(() => {
          erasureSettled = true;
        });
        // The erasure either finishes (nothing stops it) or queues behind the
        // tick's lock. Either way the run lands only after that.
        await until(
          async () => erasureSettled || (await lockWaiters()) > waitersBefore + 1,
          30_000,
          'the erasure to finish or queue'
        );
        const erasureWaitedForTick = !erasureSettled;
        hold.release();
        const [, tickResult, scheduledResult] = await Promise.all([hold.held, tick, erasure]);
        receiptIds.push(scheduledResult.receiptId);
        userIds.splice(userIds.indexOf(scheduled.id), 1);
        console.log(
          `  (the erasure ${erasureWaitedForTick ? 'waited for' : 'finished before'} the run)`
        );
        check(tickResult.processed === 1, 'the tick ran the schedule');
      } finally {
        hold.release();
      }
      check(
        !(await runInputOf(first.workflowId)).includes(scheduled.email.toLowerCase()),
        'tick first: the run does not name the erased address'
      );
      const firstAfter = await prisma.aiWorkflowSchedule.findUniqueOrThrow({
        where: { id: first.scheduleId },
      });
      check(
        JSON.stringify(firstAfter.inputTemplate) === JSON.stringify({ userEmail: '' }),
        'and the schedule’s template was blanked'
      );

      // Erasure first: a template still naming them, as a tick's copy from
      // before the erasure would, gives a run with the address blanked.
      const gone = await person('gone', true);
      const goneResult = await eraseUser({
        userId: gone.id,
        actorUserId: admin.id,
        reason: 'admin_action',
      });
      receiptIds.push(goneResult.receiptId);
      userIds.splice(userIds.indexOf(gone.id), 1);
      const second = await scheduleEmailing(` ${gone.email.toUpperCase()} `, 'erasure-first');
      const secondResult = await processDueSchedules();
      check(secondResult.processed === 1, 'the tick ran the schedule');
      check(
        (await runInputOf(second.workflowId)) === JSON.stringify({ useremail: '' }),
        'erasure first: the run was made with the address blanked'
      );
    }

    console.log('\n✓ smoke:erasure-writers passed');
  } finally {
    await prisma.aiAdminAuditLog
      .deleteMany({
        where: {
          OR: [
            { entityId: { in: [...subscriptionIds, ...workflowIds, ...scheduleIds] } },
            { action: 'workflow.draft.save', entityId: { in: workflowIds } },
          ],
        },
      })
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
  console.error('\n✗ smoke:erasure-writers failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
