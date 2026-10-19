/**
 * Erasure smoke: an account deletion is recorded before any erasure work, and
 * a failed or killed one is finished by the retrier, once (t-842).
 *
 * Proves against real Postgres what the mocked unit tests cannot:
 *
 *   • **Record, disable, then fail.** `requestUserErasure()` whose erasure
 *     throws (a fork hook that fails its first run) leaves the person's row
 *     with the intent recorded and a backoff set, their sessions gone, their
 *     API key revoked, and sign-in refused.
 *   • **The retrier finishes it.** `processPendingErasures()` leaves it alone
 *     until the backoff runs out, then erases the person with the stored
 *     actor and reason, and writes one receipt.
 *   • **Two retriers at once.** A request killed part-way (the intent and an
 *     expired lease, written directly) is taken by exactly one of two
 *     concurrent `processPendingErasures()` runs: one claim, one receipt.
 *   • **The admin who asked is erased first.** The retry still erases the
 *     person. The audit row it writes cannot name the erased admin (a foreign
 *     key to `User`), so it names the person instead, and loses that when the
 *     person's row goes.
 *
 * Refuses to run if the database already holds a pending erasure it did not
 * create, since the retrier would erase that person too. Everything it
 * creates is a `smoke-test-pending-*` row, removed on every path. Skips
 * cleanly (exit 0) when no database is reachable.
 *
 * Run with:
 *   npm run smoke:erasure-pending
 */

import { prisma } from '@/lib/db/client';
import {
  erasureBackoffMs,
  processPendingErasures,
  requestUserErasure,
} from '@/lib/privacy/erasure-requests';
import { registerErasureCleanupHook } from '@/lib/privacy/erasure-hooks';
import { refuseIfErasurePending } from '@/lib/auth/config';
import { eraseUser } from '@/lib/privacy/erase-user';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

const PREFIX = 'smoke-test-pending';
const stamp = Date.now();
const MINUTE = 60 * 1000;

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

/** People whose erasure fails on its first try. */
const failOnce = new Set<string>();

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure-pending skipped — no database reachable.');
    return;
  }

  const foreign = await prisma.user.count({ where: { erasureRequestedAt: { not: null } } });
  if (foreign > 0) {
    throw new Error(
      `${foreign} pending erasure(s) already in this database; the retrier would erase them too. ` +
        'Let the maintenance tick finish them first.'
    );
  }

  registerErasureCleanupHook({
    name: `${PREFIX}-fail-once`,
    scrubInTransaction: ({ userId }) =>
      failOnce.delete(userId)
        ? Promise.reject(new Error('smoke: first erasure attempt fails'))
        : Promise.resolve(),
  });

  const userIds: string[] = [];
  const person = async (label: string, role?: string) => {
    const user = await prisma.user.create({
      data: {
        name: `${PREFIX} ${label}`,
        email: `${PREFIX}-${label}-${stamp}@example.com`,
        emailVerified: true,
        ...(role ? { role } : {}),
      },
    });
    userIds.push(user.id);
    return user;
  };
  const subscriptionIds: string[] = [];
  const receiptsFor = (userId: string) =>
    prisma.dataErasureReceipt.findMany({ where: { subjectUserId: userId } });

  try {
    const admin = await person('admin', PLATFORM_ADMIN_ROLE);

    // ── 1. Record, disable, then fail ──────────────────────────────────────
    console.log('a failed erasure is recorded, and the account disabled');
    const failing = await person('failing');
    await prisma.session.create({
      data: {
        token: `${PREFIX}-token-${stamp}`,
        userId: failing.id,
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      },
    });
    const key = await prisma.aiApiKey.create({
      data: {
        userId: failing.id,
        name: `${PREFIX} key`,
        keyHash: `${PREFIX}-hash-${stamp}`,
        keyPrefix: 'sk_smoke',
      },
    });
    failOnce.add(failing.id);

    const before = Date.now();
    let threw = false;
    try {
      await requestUserErasure({
        userId: failing.id,
        actorUserId: admin.id,
        reason: 'admin_action',
      });
    } catch {
      threw = true;
    }
    check(threw, 'the request reports the failed erasure');

    const pending = await prisma.user.findUnique({ where: { id: failing.id } });
    check(pending !== null, 'the account still exists');
    check(pending?.erasureRequestedAt !== null, 'with the intent recorded');
    check(
      pending?.erasureRequestedBy === admin.id && pending.erasureReason === 'admin_action',
      'naming who asked and why'
    );
    check(pending?.erasureAttempts === 1, 'after one attempt');
    const nextAt = pending?.erasureNextAttemptAt?.getTime() ?? 0;
    check(
      nextAt >= before + erasureBackoffMs(1) && nextAt < before + 5 * MINUTE,
      'and the next attempt set to the first backoff, not the full lease'
    );
    check(
      (await prisma.session.count({ where: { userId: failing.id } })) === 0,
      'its sessions are gone'
    );
    const revoked = await prisma.aiApiKey.findUnique({ where: { id: key.id } });
    check(revoked?.revokedAt !== null, 'its API key is revoked');
    let refused = false;
    try {
      await refuseIfErasurePending(failing.id);
    } catch {
      refused = true;
    }
    check(refused, 'and sign-in is refused');

    // ── 2. The retrier finishes it ─────────────────────────────────────────
    console.log('the retrier finishes it once the backoff has run out');
    const early = await processPendingErasures(new Date());
    check(early.claimed === 0 && early.pending === 1, 'not before the backoff');

    const due = await processPendingErasures(new Date(nextAt + 1000));
    check(due.claimed === 1 && due.erased === 1, 'then claimed and erased');
    check(
      (await prisma.user.findUnique({ where: { id: failing.id } })) === null,
      'the account is gone'
    );
    const receipts = await receiptsFor(failing.id);
    check(receipts.length === 1, 'with one receipt');
    check(
      receipts[0].actorUserId === admin.id && receipts[0].reason === 'admin_action',
      'recording the stored actor and reason'
    );

    // ── 3. Two retriers at once ────────────────────────────────────────────
    console.log('a killed request is erased once by two concurrent retriers');
    const killed = await person('killed');
    await prisma.user.update({
      where: { id: killed.id },
      data: {
        erasureRequestedAt: new Date(Date.now() - 30 * MINUTE),
        erasureRequestedBy: killed.id,
        erasureReason: 'self_service',
        erasureAttempts: 1,
        // The killed request's lease, run out.
        erasureNextAttemptAt: new Date(Date.now() - 10 * MINUTE),
      },
    });
    const [a, b] = await Promise.all([processPendingErasures(), processPendingErasures()]);
    check(a.claimed + b.claimed === 1, 'exactly one retrier claims it');
    check(a.erased + b.erased === 1 && a.failed + b.failed === 0, 'and it is erased without error');
    check((await receiptsFor(killed.id)).length === 1, 'with one receipt');
    check(
      (await prisma.user.count({ where: { erasureRequestedAt: { not: null } } })) === 0,
      'and nothing is left pending'
    );

    // ── 4. The admin who asked is erased first ─────────────────────────────
    console.log('a retry still erases the person after the admin who asked is erased');
    const asker = await person('asker', PLATFORM_ADMIN_ROLE);
    const orphaned = await person('orphaned');
    // Erasing them clears this subscription and writes an audit row naming
    // the actor: the write that would fail on an erased admin's id.
    const subscription = await prisma.aiWebhookSubscription.create({
      data: {
        channel: 'email',
        emailAddress: orphaned.email,
        events: ['workflow_failed'],
        createdBy: orphaned.id,
      },
    });
    subscriptionIds.push(subscription.id);
    failOnce.add(orphaned.id);
    await requestUserErasure({
      userId: orphaned.id,
      actorUserId: asker.id,
      reason: 'admin_action',
    }).catch(() => undefined);
    check(
      (await prisma.user.findUnique({ where: { id: orphaned.id } }))?.erasureRequestedBy ===
        asker.id,
      'the first attempt failed, naming the admin who asked'
    );
    await eraseUser({ userId: asker.id, actorUserId: asker.id, reason: 'self_service' });

    const retried = await processPendingErasures(new Date(Date.now() + 5 * MINUTE));
    check(retried.erased === 1 && retried.failed === 0, 'the retry erases the person');
    check(
      (await prisma.user.findUnique({ where: { id: orphaned.id } })) === null,
      'the account is gone'
    );
    const audit = await prisma.aiAdminAuditLog.findFirst({
      where: { entityId: subscription.id, action: 'webhook_subscription.recipient_erased' },
    });
    check(audit !== null && audit.userId === null, 'its audit row stands, with no actor');

    console.log('\n✓ smoke:erasure-pending passed');
  } finally {
    await prisma.aiAdminAuditLog
      .deleteMany({ where: { entityId: { in: subscriptionIds } } })
      .catch(() => undefined);
    await prisma.aiWebhookSubscription
      .deleteMany({ where: { id: { in: subscriptionIds } } })
      .catch(() => undefined);
    await prisma.dataErasureReceipt
      .deleteMany({ where: { subjectUserId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' }).catch(async (err) => {
  console.error('\n✗ smoke:erasure-pending failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
