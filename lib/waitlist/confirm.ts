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
 * Confirm the entry if `token` is one of its current confirmation tokens, and
 * use up every token it has. `'invalid'` for a wrong, expired or used token, an
 * unknown entry, and an org that cannot be entered alike: the route gives them
 * one answer.
 *
 * The tokens are tenant-owned, like the entry, so the entry's org is entered
 * first (`runAsWaitlistEntryOrg()` reads only its org) and the token is
 * checked inside it. Nothing of the entry itself is read or written until the
 * token matches.
 */
export async function confirmWaitlistEntry(
  entryId: string,
  token: string,
  now: Date = new Date()
): Promise<'confirmed' | 'invalid'> {
  const result = await runAsWaitlistEntryOrg(entryId, async () => {
    const tokenId = await findConfirmToken(entryId, token, now);
    if (!tokenId) return 'invalid' as const;
    return prisma.$transaction(async (tx) => {
      // Single use: two clicks of the same link confirm once, and the second
      // is told the link is used.
      const used = await tx.waitlistConfirmToken.deleteMany({ where: { id: tokenId } });
      if (used.count === 0) return 'invalid' as const;
      // Never moves an earlier confirmation; confirming a removed entry
      // records that the address is the person's and leaves it removed.
      await tx.waitlistEntry.updateMany({
        where: { id: entryId, confirmedAt: null },
        data: { confirmedAt: now },
      });
      // The entry's other links (earlier sends) have nothing left to do.
      await tx.waitlistConfirmToken.deleteMany({ where: { entryId } });
      return 'confirmed' as const;
    });
  });
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
