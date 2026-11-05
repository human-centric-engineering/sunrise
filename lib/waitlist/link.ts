/**
 * Linking a waitlist entry to the account its invitation created (§125 t-978).
 *
 * Its own module so the sign-up hook (`lib/auth/config.ts`) imports one
 * update and the entry-org lookup, not the invite path.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { runAsWaitlistEntryOrg } from '@/lib/waitlist/entry-org';

/**
 * Link the entry an invitation was sent from to the account that redeemed it:
 * `userId` and `joinedAt`. Called by Sunrise's own sign-up after-hook, on the
 * password and the OAuth path alike, only when the redeemed invitation names
 * an entry — so a sign-up with no waitlist invitation touches no entry.
 *
 * Keyed by the entry id the invitation carried, inside the entry's own org.
 * The address is a guard, not the key: the invitation was for that address
 * and both sign-up paths prove it, so an entry whose address differs is not
 * this account's and is left. An entry already linked is left too. Never
 * throws — the account exists by now, and failing here would report a
 * successful sign-up as an error; a failure is logged with the ids.
 */
export async function linkWaitlistEntryToAccount(input: {
  entryId: string;
  userId: string;
  email: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  try {
    const result = await runAsWaitlistEntryOrg(input.entryId, () =>
      prisma.waitlistEntry.updateMany({
        where: { id: input.entryId, email: input.email.trim().toLowerCase(), userId: null },
        data: { userId: input.userId, joinedAt: now },
      })
    );
    const linked = result.found && result.value.count === 1;
    if (linked) {
      logger.info('Waitlist entry linked to its new account', {
        entryId: input.entryId,
        userId: input.userId,
      });
    } else {
      // Erased since the invite, its org suspended, already linked, or a
      // different address: nothing to link, and nothing to undo.
      logger.warn('Waitlist invitation redeemed but no entry was linked', {
        entryId: input.entryId,
        userId: input.userId,
        reason: result.found ? 'no-match' : result.reason,
      });
    }
    return linked;
  } catch (error) {
    logger.error('Failed to link a waitlist entry to its new account', error, {
      entryId: input.entryId,
      userId: input.userId,
    });
    return false;
  }
}
