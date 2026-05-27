/**
 * Right-to-erasure service (GDPR Art. 17).
 *
 * `prisma.user.delete` triggers the schema's referential actions — personal
 * data cascades away, org config + audit rows are retained with their
 * creator/userId set null (see the `account_deletion_erasure_cascade`
 * migration for the per-table policy). This service wraps that delete with
 * the things the DB cascade structurally cannot do:
 *
 *   1. Scrub residual PII the cascade leaves behind — `clientIp` (an IP
 *      address) on the user's retained admin-audit rows. `SetNull` drops the
 *      `userId` link but not the IP, so we null it before the link is gone.
 *   2. Write an append-only `DataErasureReceipt` for accountability
 *      (Art. 5(2)) without re-introducing PII (opaque id + email hash).
 *   3. Remove the user's stored avatar blobs (object storage, not the DB).
 *
 * The scrub, receipt, and delete run in one transaction so they commit or
 * roll back together. Avatar cleanup runs first as a best-effort side effect
 * (object storage cannot enlist in the DB transaction).
 */

import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getErasureCleanupHooks } from '@/lib/privacy/erasure-hooks';

export type ErasureReason = 'self_service' | 'admin_action';

export interface EraseUserParams {
  /** Id of the user to erase. */
  userId: string;
  /** Email of the user — stored only as a hash on the receipt. */
  userEmail: string;
  /** Who initiated the erasure (the user themselves, or an admin). */
  actorUserId: string;
  reason: ErasureReason;
}

export interface EraseUserResult {
  receiptId: string;
  erasedAt: Date;
}

/** Non-reversible correlation handle — never store the raw email on the receipt. */
function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Permanently erase a user, the data that cascades from them, and the residual
 * PII the cascade can't reach; record an erasure receipt. Idempotent only in
 * the sense that a second call throws (the user row is already gone) — callers
 * guard with their own existence/authorization checks first.
 */
export async function eraseUser(params: EraseUserParams): Promise<EraseUserResult> {
  const { userId, userEmail, actorUserId, reason } = params;

  // 1. Object-storage blobs (avatars) — best-effort, outside the DB transaction.
  const { deleteByPrefix, isStorageEnabled } = await import('@/lib/storage/upload');
  if (isStorageEnabled()) {
    await deleteByPrefix(`avatars/${userId}/`);
  }

  // 1b. App-registered external cleanup (object storage, search indexes, …).
  // Best-effort like the avatar cleanup above: a hook failure is logged and
  // swallowed so app-side trouble can never block the user's erasure.
  for (const hook of getErasureCleanupHooks()) {
    if (!hook.cleanupExternal) continue;
    try {
      await hook.cleanupExternal({ userId });
    } catch (error) {
      logger.error('Erasure cleanup hook (external) failed', {
        userId,
        hook: hook.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2. Scrub residual PII, write the receipt, and delete — atomically.
  const receipt = await prisma.$transaction(async (tx) => {
    // Retained admin-audit rows keep their IP after `userId` is SetNull'd.
    await tx.aiAdminAuditLog.updateMany({
      where: { userId },
      data: { clientIp: null },
    });

    // App-registered in-transaction scrub. Runs before `tx.user.delete()` so
    // hooks can still match retained rows on `userId`, and atomically with the
    // delete — a throw here rolls the entire erasure back.
    for (const hook of getErasureCleanupHooks()) {
      if (!hook.scrubInTransaction) continue;
      await hook.scrubInTransaction({ tx, userId });
    }

    const created = await tx.dataErasureReceipt.create({
      data: {
        subjectUserId: userId,
        subjectEmailHash: hashEmail(userEmail),
        actorUserId,
        reason,
      },
    });

    // Cascades erase personal data; SetNull de-attributes retained config/audit.
    await tx.user.delete({ where: { id: userId } });

    return created;
  });

  logger.info('User erased', { userId, actorUserId, reason, receiptId: receipt.id });

  return { receiptId: receipt.id, erasedAt: receipt.erasedAt };
}
