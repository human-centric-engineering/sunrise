/**
 * Erasing a waitlist entry, with a receipt (§125 t-975).
 *
 * A person on the waitlist with no account can be erased two ways: by the
 * leave link in a waitlist email (t-977, `reason: 'self_service'`) or by an
 * admin (t-976, `'admin_action'`). Both call {@link eraseWaitlistEntry}, which
 * deletes the entry and writes a `DataErasureReceipt` of kind `waitlist` in one
 * transaction — so "did you erase me?" has an answer that holds no data: the
 * address only as `subjectEmailHash`.
 *
 * **What the receipt says.** `subjectUserId` is null, always — also for an
 * entry linked to an account by a redeemed invitation. Erasing the entry is
 * not erasing the account, and the readers that look a receipt up by
 * `subjectUserId` (`finishedErasure()`, the subject export's account arm) do
 * not read its kind: one naming a live account would be shown to it as an
 * erasure of the account. The linked account is `metadata.linkedUserId`
 * instead. The CHECK `data_erasure_receipt_subject_kind` holds the pairing.
 * `metadata.addressVerified` is `false`, also for a confirmed entry: the flag
 * means "erasure stripped this address from configuration", and this one
 * strips none — it deletes one entry. The readers ask for account receipts
 * only, so this is the second of two locks, not the only one.
 * `metadata.entryConfirmed` records whether the owner had proved the address,
 * and `metadata.orgId` whose list it was on: the receipt itself has no org. See
 * `.context/privacy/data-erasure.md`, "Waitlist-only receipts".
 *
 * **Tenancy.** Call inside the entry's org (`runAsOrg`): the entry is
 * tenant-owned and is read under the caller's scope, so an id from another org
 * is not found. The receipt is a system model, like every other receipt.
 *
 * **A pending invitation for the address goes too** (spec, *Rules carried
 * over*: otherwise a working sign-up link survives the erasure) — the one
 * this org issued. Invitations are install-wide, one per address, and name the
 * org the invitee joins (`metadata.orgId`, absent ⇒ the install org), so one
 * for another org is that org's to keep; one whose metadata cannot be read is
 * left and logged rather than guessed at.
 *
 * Erasing an account (`eraseUser()`) deletes that account's entries itself
 * and writes the account receipt; this is not called for them.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { subjectEmailHash } from '@/lib/privacy/erased-subjects';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { INVITATION_IDENTIFIER_PREFIX } from '@/lib/utils/invitation-token';
import { parseInvitationMetadata } from '@/lib/validations/admin';

export interface EraseWaitlistEntryInput {
  entryId: string;
  /** The admin who erased it; null for the leave link (the person themselves). */
  actorUserId: string | null;
  reason: 'self_service' | 'admin_action';
}

export interface WaitlistErasureReceipt {
  receiptId: string;
  erasedAt: Date;
  /** Pending invitations for the address this org issued, deleted with the entry. */
  invitationsDeleted: number;
}

/**
 * Delete the entry and write its receipt, atomically. Null when no entry has
 * that id in the current org — already erased, or never there — and then
 * nothing is written: a receipt is the record of an erasure that happened.
 */
export async function eraseWaitlistEntry(
  input: EraseWaitlistEntryInput
): Promise<WaitlistErasureReceipt | null> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.waitlistEntry.findUnique({
      where: { id: input.entryId },
      select: { id: true, email: true, list: true, confirmedAt: true, orgId: true, userId: true },
    });
    if (!entry) return null;

    // deleteMany, not delete: a concurrent erasure of the same entry finds
    // nothing to delete rather than throwing, and writes no second receipt.
    const deleted = await tx.waitlistEntry.deleteMany({ where: { id: entry.id } });
    if (deleted.count === 0) return null;

    const receipt = await tx.dataErasureReceipt.create({
      data: {
        subjectKind: 'waitlist',
        subjectUserId: null,
        subjectEmailHash: subjectEmailHash(entry.email),
        actorUserId: input.actorUserId,
        reason: input.reason,
        metadata: {
          // Never refused by the recipient writers: this erasure strips no
          // configuration (see the module comment).
          addressVerified: false,
          entryConfirmed: entry.confirmedAt !== null,
          list: entry.list,
          orgId: entry.orgId,
          // The account an invitation linked the entry to, if any: how the
          // subject export finds this receipt for it (`waitlistReceiptsOf()`).
          linkedUserId: entry.userId,
        },
      },
      select: { id: true, erasedAt: true },
    });

    const invitations = await tx.verification.findMany({
      where: { identifier: `${INVITATION_IDENTIFIER_PREFIX}${entry.email}` },
      select: { id: true, metadata: true },
    });
    const ours: string[] = [];
    let unreadable = 0;
    for (const invitation of invitations) {
      const metadata = parseInvitationMetadata(invitation.metadata);
      if (!metadata) unreadable += 1;
      else if ((metadata.orgId ?? INSTALL_ORG_ID) === entry.orgId) ours.push(invitation.id);
    }
    if (unreadable > 0) {
      logger.warn('Waitlist erasure left an invitation it could not read', {
        entryId: entry.id,
        count: unreadable,
      });
    }
    const deletedInvitations =
      ours.length === 0
        ? { count: 0 }
        : await tx.verification.deleteMany({ where: { id: { in: ours } } });

    return {
      receiptId: receipt.id,
      erasedAt: receipt.erasedAt,
      invitationsDeleted: deletedInvitations.count,
    };
  });
}
