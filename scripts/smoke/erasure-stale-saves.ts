/**
 * Erasure smoke: a form loaded before an erasure cannot save the person back,
 * and one loaded after it can (§122 t-899).
 *
 * Proves against real Postgres, with the real `eraseUser()`, for the
 * escalation list, a webhook subscription and a schedule:
 *
 *   1. **Loaded.** The form reads the record naming Jane, and its version.
 *   2. **Erased.** Jane is erased, which scrubs her out of all three.
 *   3. **Stale save refused.** The form's save, carrying the version it
 *      loaded, goes through the check the routes make
 *      (`assertUnchangedSince`, `lib/orchestration/config-versions.ts`) and
 *      is refused with 412 `STALE_RECORD`. Nothing is written, and the row
 *      still does not name her.
 *   4. **Reloaded, saved.** The form reloads, Jane's address is typed back in
 *      on purpose, and the save with the new version is written. The
 *      all-time refusal these routes made before t-899 would have stopped it.
 *
 * It drives the routes' own check and write, not the routes: their guard
 * reads the request's headers through Next's request scope, which a script
 * does not have. That the routes call this check before they write, require
 * `If-Match` (428) and return the version is held by their tests
 * (`webhooks.id.test.ts`, `settings.test.ts`, `schedules.route.test.ts`).
 *
 * The escalation list is on the shared settings row, so its value is put back
 * on every path. Everything else it creates is a `smoke-test-saves-*` row,
 * removed on every path. Skips cleanly (exit 0) when no database is reachable.
 *
 * Run with:
 *   npm run smoke:erasure-stale-saves
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { StaleRecordError } from '@/lib/api/errors';
import { eraseUser } from '@/lib/privacy/erase-user';
import { WRITER_TRANSACTION_OPTIONS } from '@/lib/privacy/erased-subjects';
import {
  assertUnchangedSince,
  lockedVersion,
  type VersionedRecord,
} from '@/lib/orchestration/config-versions';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

const PREFIX = 'smoke-test-saves';
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

/** A record the smoke saves, with the write its route makes and how to read it back. */
interface Surface {
  what: string;
  record: VersionedRecord;
  /** The route's write of the form's copy, with Jane's address in it. */
  write: (tx: Prisma.TransactionClient, address: string) => Promise<unknown>;
  stored: () => Promise<unknown>;
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure-stale-saves skipped — no database reachable.');
    return;
  }

  const userIds: string[] = [];
  const receiptIds: string[] = [];
  let workflowId: string | null = null;
  let subscriptionId: string | null = null;
  const settingsBefore = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { escalationConfig: true },
  });

  try {
    if (!settingsBefore) {
      console.log(
        'smoke:erasure-stale-saves skipped — no settings row (open the settings page once).'
      );
      return;
    }
    const admin = await prisma.user.create({
      data: {
        name: `${PREFIX} admin`,
        email: `${PREFIX}-admin-${stamp}@example.com`,
        emailVerified: true,
      },
    });
    userIds.push(admin.id);
    const jane = await prisma.user.create({
      data: {
        name: `${PREFIX} jane`,
        email: `${PREFIX}-jane-${stamp}@example.com`,
        emailVerified: true,
      },
    });
    userIds.push(jane.id);
    const ops = `${PREFIX}-ops-${stamp}@example.com`;
    const names = (value: unknown) =>
      JSON.stringify(value ?? null)
        .toLowerCase()
        .includes(jane.email.toLowerCase());

    // ── The records, each naming Jane ────────────────────────────────────
    await prisma.aiOrchestrationSettings.update({
      where: { slug: 'global' },
      data: { escalationConfig: { emailAddresses: [ops, jane.email], notifyOnPriority: 'all' } },
    });
    const subscription = await prisma.aiWebhookSubscription.create({
      data: {
        channel: 'email',
        emailAddress: jane.email,
        events: [`${PREFIX}-${stamp}`],
        createdBy: admin.id,
        orgId: INSTALL_ORG_ID,
      },
    });
    subscriptionId = subscription.id;
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
    workflowId = workflow.id;
    const schedule = await prisma.aiWorkflowSchedule.create({
      data: {
        workflowId: workflow.id,
        name: `${PREFIX} schedule`,
        cronExpression: '0 9 * * *',
        inputTemplate: { sendTo: jane.email },
        // Never due, so no tick runs it.
        isEnabled: false,
        createdBy: admin.id,
      },
    });

    const surfaces: Surface[] = [
      {
        what: 'the escalation list',
        record: { kind: 'escalation-list' },
        write: (tx, address) =>
          tx.aiOrchestrationSettings.update({
            where: { slug: 'global' },
            data: { escalationConfig: { emailAddresses: [ops, address], notifyOnPriority: 'all' } },
          }),
        stored: async () =>
          (
            await prisma.aiOrchestrationSettings.findUniqueOrThrow({
              where: { slug: 'global' },
              select: { escalationConfig: true },
            })
          ).escalationConfig,
      },
      {
        what: 'the subscription',
        record: { kind: 'webhook-subscription', id: subscription.id },
        write: (tx, address) =>
          tx.aiWebhookSubscription.update({
            where: { id: subscription.id },
            data: { emailAddress: address, isActive: true },
          }),
        stored: async () =>
          (await prisma.aiWebhookSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
            .emailAddress,
      },
      {
        what: 'the schedule',
        record: { kind: 'workflow-schedule', id: schedule.id },
        write: (tx, address) =>
          tx.aiWorkflowSchedule.update({
            where: { id: schedule.id },
            data: { inputTemplate: { sendTo: address } },
          }),
        stored: async () =>
          (await prisma.aiWorkflowSchedule.findUniqueOrThrow({ where: { id: schedule.id } }))
            .inputTemplate,
      },
    ];
    /** The route's versioned save: check under the lock, then write. */
    const save = (s: Surface, loadedAt: string, address: string) =>
      prisma.$transaction(async (tx) => {
        await assertUnchangedSince(tx, s.record, [loadedAt]);
        await s.write(tx, address);
      }, WRITER_TRANSACTION_OPTIONS);
    const load = (s: Surface) => prisma.$transaction((tx) => lockedVersion(tx, s.record));

    // ── 1. Loaded ────────────────────────────────────────────────────────
    console.log('loaded');
    const loaded = new Map<Surface, string>();
    for (const s of surfaces) {
      check(names(await s.stored()), `${s.what} names her`);
      loaded.set(s, await load(s));
    }

    // ── 2. Erased ────────────────────────────────────────────────────────
    console.log('erased');
    const result = await eraseUser({
      userId: jane.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    receiptIds.push(result.receiptId);
    userIds.splice(userIds.indexOf(jane.id), 1);
    for (const s of surfaces) {
      check(!names(await s.stored()), `the erasure took her out of ${s.what}`);
    }

    // ── 3. Stale save refused ────────────────────────────────────────────
    console.log('stale saves');
    for (const s of surfaces) {
      const refused = await save(s, loaded.get(s) ?? '', jane.email).then(
        () => null,
        (err: unknown) => err
      );
      check(
        refused instanceof StaleRecordError && refused.status === 412,
        `a save of ${s.what} from the form loaded before the erasure is refused with 412`
      );
      check(!names(await s.stored()), `and ${s.what} still does not name her`);
    }

    // ── 4. Reloaded, saved ───────────────────────────────────────────────
    console.log('reloaded');
    for (const s of surfaces) {
      const version = await load(s);
      check(version !== loaded.get(s), `reloading ${s.what} gives a new version`);
      await save(s, version, jane.email);
      check(
        names(await s.stored()),
        `her address, typed back into ${s.what} on a freshly loaded form, saves`
      );
    }

    console.log('\n✓ smoke:erasure-stale-saves passed');
  } finally {
    if (settingsBefore) {
      await prisma.aiOrchestrationSettings
        .update({
          where: { slug: 'global' },
          data: { escalationConfig: settingsBefore.escalationConfig ?? Prisma.JsonNull },
        })
        .catch(() => undefined);
    }
    if (workflowId) {
      const id = workflowId;
      await prisma.aiWorkflowSchedule
        .deleteMany({ where: { workflowId: id } })
        .catch(() => undefined);
      await prisma.aiWorkflow.deleteMany({ where: { id } }).catch(() => undefined);
    }
    if (subscriptionId) {
      const id = subscriptionId;
      await prisma.aiWebhookSubscription.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await prisma.dataErasureReceipt
      .deleteMany({ where: { id: { in: receiptIds } } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' }).catch(async (err) => {
  console.error('\n✗ smoke:erasure-stale-saves failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
