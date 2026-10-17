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
 *   • **Erasure first.** A writer with a copy read before the erasure (a
 *     subscription edit, a workflow draft emailing the person) is refused with
 *     a 400 once the erasure has committed; a draft naming them only as an
 *     approver id saves with the id stripped.
 *   • **Re-registered.** Someone who signs up again with the erased address,
 *     and verifies it, may be named again.
 *   • **Unverified.** An unverified account's erased address is not refused:
 *     erasure never matched it, and it may be a stranger's inbox.
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
import { refuseErasedSubjects } from '@/lib/privacy/erased-subjects';
import { saveDraft } from '@/lib/orchestration/workflows/version-service';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      await refuseErasedSubjects(tx, { addresses: [early.email] }, 'emailAddress');
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
      await refused(() =>
        prisma.$transaction((tx) =>
          refuseErasedSubjects(tx, { addresses: [staleAddress] }, 'emailAddress')
        )
      ),
      'a subscription edit holding their address (another case, padded) is refused'
    );
    const addressedDef = workflowDefinitionSchema.parse({
      steps: [
        {
          id: 'n',
          name: 'Notify',
          type: 'send_notification',
          config: { channel: 'email', to: staleAddress, subject: 'Hi', bodyTemplate: 'x' },
          nextSteps: [],
        },
      ],
      entryStepId: 'n',
      errorStrategy: 'fail',
    });
    check(
      await refused(() =>
        saveDraft({ workflowId: workflow.id, definition: addressedDef, userId: admin.id })
      ),
      'a builder tab emailing their address is refused'
    );
    const refusedDraft = await prisma.aiWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
    check(
      !JSON.stringify(refusedDraft.draftDefinition)
        .toLowerCase()
        .includes(late.email.toLowerCase()),
      'and that draft was not written'
    );
    await saveDraft({ workflowId: workflow.id, definition: def, userId: admin.id });
    const strippedDraft = await prisma.aiWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
    check(
      !JSON.stringify(strippedDraft.draftDefinition).includes(late.id),
      'a builder tab naming them as an approver saves, with their id stripped'
    );

    // ── 3. Re-registered and verified: may be named again ─────────────────
    console.log('re-registered');
    await person('late-again', true, late.email);
    check(
      !(await refused(() =>
        prisma.$transaction((tx) =>
          refuseErasedSubjects(tx, { addresses: [late.email] }, 'emailAddress')
        )
      )),
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
      !(await refused(() =>
        prisma.$transaction((tx) =>
          refuseErasedSubjects(tx, { addresses: [unverified.email] }, 'emailAddress')
        )
      )),
      'an unverified account’s address is not refused'
    );

    console.log('\n✓ smoke:erasure-writers passed');
  } finally {
    await prisma.aiAdminAuditLog
      .deleteMany({
        where: {
          OR: [
            { entityId: { in: [...subscriptionIds, ...workflowIds] } },
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
