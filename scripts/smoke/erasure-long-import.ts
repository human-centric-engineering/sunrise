/**
 * Erasure smoke: a long backup import does not time out an erasure of someone
 * it names (t-840).
 *
 * Proves against real Postgres what the mocked unit tests cannot: that the
 * erasure waits for the import's locks before its own 60 s transaction opens,
 * rather than inside it.
 *
 *   • **Import first, and long.** A real `importOrchestrationConfig()` of a
 *     bundle naming the person takes their lock, then stalls (this script holds
 *     the workflow row the import writes a version to) for longer than the
 *     erasure's transaction may run. An erasure started meanwhile completes
 *     once the import commits, and takes the person out of what it imported.
 *     Waiting inside its transaction instead, it would time out and erase
 *     nothing.
 *   • **Erasure first.** An import of a bundle naming someone already erased
 *     strips them, with a warning.
 *   • **The try.** `tryLockSubjects()` says false for a lock another session
 *     holds and true once it is free, which the erasure's retry relies on.
 *
 * Takes a little over a minute: the stall has to outlast
 * `ERASURE_TRANSACTION_TIMEOUT_MS`. Everything it creates is a
 * `smoke-test-import-*` row, removed on every path. Skips cleanly (exit 0)
 * when no database is reachable.
 *
 * Run with:
 *   npm run smoke:erasure-long-import
 */

import { prisma } from '@/lib/db/client';
import { ERASURE_TRANSACTION_TIMEOUT_MS, eraseUser } from '@/lib/privacy/erase-user';
import { importOrchestrationConfig } from '@/lib/orchestration/backup/importer';
import { lockSubjects, tryLockSubjects } from '@/lib/privacy/erased-subjects';
import { holdWorkflowRow, lockWaiters, sleep, until } from '@/scripts/smoke/lock-waits';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

const PREFIX = 'smoke-test-import';
const stamp = Date.now();
const SCOPE = { orgId: INSTALL_ORG_ID, includeShared: false };

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

/** A bundle restoring `slug` with a step that emails `to`. */
function bundleNaming(slug: string, to: string) {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data: {
      agents: [],
      capabilities: [],
      webhooks: [],
      settings: null,
      workflows: [
        {
          name: `${PREFIX} workflow`,
          slug,
          description: 'smoke',
          workflowDefinition: {
            steps: [
              {
                id: 'n',
                name: 'Notify',
                type: 'send_notification',
                config: { channel: 'email', to, subject: 'Hi', bodyTemplate: 'x' },
                nextSteps: [],
              },
            ],
            entryStepId: 'n',
            errorStrategy: 'fail',
          },
          patternsUsed: [],
          isActive: true,
          isTemplate: false,
          metadata: null,
        },
      ],
    },
  };
}

/** Whether any version of the workflow names `address`. */
async function versionsName(workflowId: string, address: string): Promise<boolean> {
  const versions = await prisma.aiWorkflowVersion.findMany({ where: { workflowId } });
  return versions.some((v) =>
    JSON.stringify(v.snapshot).toLowerCase().includes(address.toLowerCase())
  );
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure-long-import skipped — no database reachable.');
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
    const slug = `${PREFIX}-${stamp}`;
    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} workflow`,
        slug,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: { steps: [] },
        createdBy: admin.id,
      },
    });
    workflowIds.push(workflow.id);

    // ── 0. The try reports a held lock as held ─────────────────────────────
    console.log('the try');
    const probe = { userIds: [`${PREFIX}-probe-${stamp}`] };
    let releaseProbe = (): void => undefined;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probeHolder = prisma.$transaction(
      async (tx) => {
        await lockSubjects(tx, probe);
        await probeReleased;
      },
      { timeout: 30_000 }
    );
    try {
      await sleep(200);
      check(
        !(await prisma.$transaction((tx) => tryLockSubjects(tx, probe))),
        'a lock another session holds is reported as held'
      );
    } finally {
      releaseProbe();
      await probeHolder;
    }
    check(
      await prisma.$transaction((tx) => tryLockSubjects(tx, probe)),
      'and as taken once it is free'
    );

    // ── 1. A long import naming the person: the erasure waits it out ──────
    console.log(
      `import first, held for ${Math.round(ERASURE_TRANSACTION_TIMEOUT_MS / 1000) + 3} s`
    );
    const named = await person('named');
    const waitersBefore = await lockWaiters();
    // The import writes a new version of this workflow; the version's foreign
    // key is checked against this row, so the import stalls there, holding the
    // locks it took at its start for everyone the bundle names.
    const hold = holdWorkflowRow(workflow.id, ERASURE_TRANSACTION_TIMEOUT_MS + 30_000);
    let importCommittedAt = 0;
    let erasureFinishedAt = 0;
    try {
      await sleep(100);
      const imported = importOrchestrationConfig(
        bundleNaming(slug, named.email),
        admin.id,
        SCOPE
      ).then((result) => {
        importCommittedAt = Date.now();
        return result;
      });
      await until(async () => (await lockWaiters()) > waitersBefore, 10_000, 'the import to stall');

      const erasureStartedAt = Date.now();
      const erasure = eraseUser({
        userId: named.id,
        actorUserId: admin.id,
        reason: 'admin_action',
      }).then((result) => {
        erasureFinishedAt = Date.now();
        return result;
      });
      // Outlast the erasure's own transaction budget before letting the import
      // finish: an erasure that waited inside its transaction has timed out by
      // now.
      await sleep(ERASURE_TRANSACTION_TIMEOUT_MS + 3_000);
      check(erasureFinishedAt === 0, 'the erasure is still waiting while the import runs');
      hold.release();
      const [, importResult, erased] = await Promise.all([hold.held, imported, erasure]);
      receiptIds.push(erased.receiptId);
      userIds.splice(userIds.indexOf(named.id), 1);

      check(importResult.workflows.updated === 1, 'the import ran');
      check(
        erasureFinishedAt - erasureStartedAt > ERASURE_TRANSACTION_TIMEOUT_MS,
        'the erasure succeeded after waiting longer than its transaction may run'
      );
      check(erasureFinishedAt >= importCommittedAt, 'and finished after the import committed');
    } finally {
      hold.release();
    }
    check(
      !(await versionsName(workflow.id, named.email)),
      'the erasure took the person out of the version the import wrote'
    );

    // ── 2. Erasure first: the import strips them ──────────────────────────
    console.log('erasure first');
    const gone = await person('gone');
    const goneResult = await eraseUser({
      userId: gone.id,
      actorUserId: admin.id,
      reason: 'admin_action',
    });
    receiptIds.push(goneResult.receiptId);
    userIds.splice(userIds.indexOf(gone.id), 1);
    const late = await importOrchestrationConfig(bundleNaming(slug, gone.email), admin.id, SCOPE);
    check(
      late.warnings.some((w) => /people whose data was erased were removed/.test(w)),
      'an import naming someone already erased warns'
    );
    check(!(await versionsName(workflow.id, gone.email)), 'and does not write them');

    console.log('\n✓ smoke:erasure-long-import passed');
  } finally {
    await prisma.aiAdminAuditLog
      .deleteMany({ where: { entityId: { in: workflowIds } } })
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
  console.error('\n✗ smoke:erasure-long-import failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
