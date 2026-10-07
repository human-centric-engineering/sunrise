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
 *   4. Delete the contact-form messages sent from the user's stored address,
 *      when the account has verified it. `ContactSubmission` has no FK to
 *      `User`, so no cascade reaches it.
 *
 * The scrub, contact delete, receipt, and user delete run in one transaction
 * so they commit or roll back together. Avatar cleanup runs first as a
 * best-effort side effect (object storage cannot enlist in the DB transaction).
 */

import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isMultiTenant, runAsSystem } from '@/lib/tenancy/context';
import { contactSubmissionsOf } from '@/lib/privacy/contact-submissions';
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
  const { userId, actorUserId, reason } = params;

  // 1. Object-storage blobs (avatars) — best-effort, outside the DB transaction.
  const { deleteByPrefix, isStorageEnabled } = await import('@/lib/storage/upload');
  if (isStorageEnabled()) {
    await deleteByPrefix(`avatars/${userId}/`);
  }

  // At `multi`, everything below runs as the audited system scope (§107
  // t-748). A person's rows can sit in several orgs, and the routes call this
  // from inside the session's active org (or, with an admin API key, from
  // none). Core's own deletes need no scope — `user.delete`'s cascades are FK
  // actions, which RLS does not filter, and the audit-log scrub touches a
  // system model — but a fork's hook that clears a tenant-owned table would
  // otherwise reach only the caller's org, or throw "No tenant context". Every
  // hook is handed the `userId` and nothing else, so the bypass widens it to
  // that person's rows in every org. At `single` there is one org and no
  // policy, so nothing is entered: a hook keeps the implicit install org.
  const receipt = isMultiTenant()
    ? await runAsSystem(
        // Whose rows, and who asked: logged before the work, so a failed
        // erasure still leaves its audit line.
        `subject erasure: user ${userId}'s rows in every org, for ${actorUserId}`,
        () => eraseRows(params)
      )
    : await eraseRows(params);

  // The contact count is the one thing erased by address rather than by FK,
  // so it is the one the receipt cannot vouch for: log what was taken.
  logger.info('User erased', {
    userId,
    actorUserId,
    reason,
    receiptId: receipt.id,
    contactSubmissionsDeleted: receipt.contactSubmissionsDeleted,
  });
  // An unverified address matched nothing, so any contact messages sent under
  // it are still there, and only a person can decide whether they were this
  // subject's. Say so, rather than let a 0 above read as "there were none".
  if (receipt.contactSubmissionsUnverified) {
    logger.warn('Contact messages not erased: the account never verified its address', {
      userId,
      receiptId: receipt.id,
    });
  }

  return { receiptId: receipt.id, erasedAt: receipt.erasedAt };
}

/** The hooks and the transaction — at `multi`, as {@link eraseUser} runs them in the system scope. */
async function eraseRows(params: EraseUserParams): Promise<{
  id: string;
  erasedAt: Date;
  contactSubmissionsDeleted: number;
  contactSubmissionsUnverified: boolean;
}> {
  const { userId, userEmail, actorUserId, reason } = params;

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
  return prisma.$transaction(async (tx) => {
    // Retained admin-audit rows keep their IP after `userId` is SetNull'd.
    await tx.aiAdminAuditLog.updateMany({
      where: { userId },
      data: { clientIp: null },
    });

    // Contact-form messages are keyed by address alone (no FK), so the
    // cascade below never reaches them. The export hands these same rows to
    // the subject as their personal data, so they go — matched exactly, never
    // case-insensitively: an `ILIKE` here would delete a stranger's messages.
    // The address is read from the user row, as the export reads it, not taken
    // from `userEmail`: a caller's copy can be stale (a cached session that
    // predates an email change), and then this would delete the old address's
    // messages and leave the ones the export calls the subject's. An
    // unverified address matches nothing — the form proves nothing about who
    // typed it, so they may be a stranger's. A system model, so no org scope
    // is needed at either tenancy mode.
    const account = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    });
    const where = contactSubmissionsOf(account);
    const contacts = where ? await tx.contactSubmission.deleteMany({ where }) : { count: 0 };

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

    return {
      ...created,
      contactSubmissionsDeleted: contacts.count,
      contactSubmissionsUnverified: where === null,
    };
  });
}
