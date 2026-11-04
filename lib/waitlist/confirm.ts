/**
 * Confirming a waitlist address, and leaving the list (§125 t-977).
 *
 * Both are reached from a link in a waitlist email, through a page with a
 * button: opening the link alone does nothing, because mail scanners open
 * links before people do. Both work whether or not the list is open —
 * closing a list stops new joins and nothing else.
 */

import { prisma } from '@/lib/db/client';
import { eraseWaitlistEntry } from '@/lib/waitlist/erase';
import { runAsWaitlistEntryOrg } from '@/lib/waitlist/entry-org';
import { findConfirmToken, verifyLeaveToken } from '@/lib/waitlist/tokens';

/**
 * Confirm the entry if `token` is its current confirmation token, and use the
 * token up. `'invalid'` for a wrong, expired or used token, an unknown entry,
 * and an org that cannot be entered alike: the route gives them one answer.
 */
export async function confirmWaitlistEntry(
  entryId: string,
  token: string,
  now: Date = new Date()
): Promise<'confirmed' | 'invalid'> {
  // Verification is a system model: no org is needed to check the token, and
  // checking it first keeps a wrong token from reading the entry at all.
  const stored = await findConfirmToken(entryId, token, now);
  if (!stored) return 'invalid';

  const result = await runAsWaitlistEntryOrg(entryId, () =>
    prisma.$transaction(async (tx) => {
      // Single use: conditional on the row being as read, so two clicks of
      // the same link confirm once and the second is told the link is used.
      const used = await tx.verification.deleteMany({
        where: { id: stored.id, value: stored.value },
      });
      if (used.count === 0) return 'invalid' as const;
      // Never moves an earlier confirmation; confirming a removed entry
      // records that the address is the person's and leaves it removed.
      await tx.waitlistEntry.updateMany({
        where: { id: entryId, confirmedAt: null },
        data: { confirmedAt: now },
      });
      return 'confirmed' as const;
    })
  );
  return result.found ? result.value : 'invalid';
}

/**
 * Erase the entry a leave token names, with a receipt. `'invalid'` when the
 * token is not one of ours; `'left'` otherwise — also when the entry is
 * already gone, because a second click of the same link has nothing left to
 * do and the person is off the list either way.
 *
 * An entry whose org cannot be entered (suspended) is `'unavailable'`: it is
 * still there, and saying it was erased would be untrue.
 */
export async function leaveWaitlist(token: string): Promise<'left' | 'invalid' | 'unavailable'> {
  const entryId = verifyLeaveToken(token);
  if (!entryId) return 'invalid';

  const result = await runAsWaitlistEntryOrg(entryId, () =>
    eraseWaitlistEntry({ entryId, actorUserId: null, reason: 'self_service' })
  );
  // A null receipt inside the org is a concurrent leave or erase that got
  // there first: gone either way.
  if (result.found || result.reason === 'missing') return 'left';
  return 'unavailable';
}
