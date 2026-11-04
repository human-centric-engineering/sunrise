/**
 * Waitlist retention (§125): every state has a limit, set in the waitlist
 * config (`retention`) and enforced here on the maintenance tick, once per
 * org (`waitlistRetention` in `lib/orchestration/maintenance/platform-jobs.ts`).
 *
 * - **Unconfirmed** (t-977): deleted `unconfirmedDays` (default 30) after it
 *   joined. Nothing proves the address was the person's own, so it is not
 *   kept for long. An entry linked to an account is never deleted here; it is
 *   erased with the account.
 *
 * A deletion here is retention, not an erasure request, so it writes no
 * receipt. The entry's outstanding confirmation token goes with it.
 *
 * Batch-capped: a non-empty run tells the tick there may be more.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getWaitlistConfig } from '@/lib/waitlist/config';
import { confirmIdentifier } from '@/lib/waitlist/tokens';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Most entries one run deletes per org. */
export const WAITLIST_RETENTION_BATCH = 500;

export interface WaitlistRetentionResult {
  unconfirmedDeleted: number;
}

/**
 * Delete this org's entries past their windows. Call inside the org (the
 * per-org job does). A no-op when the app has no waitlist.
 */
export async function pruneWaitlistEntries(
  now: Date = new Date()
): Promise<WaitlistRetentionResult> {
  const config = getWaitlistConfig();
  if (!config) return { unconfirmedDeleted: 0 };

  const cutoff = new Date(now.getTime() - config.retention.unconfirmedDays * DAY_MS);
  const due = await prisma.waitlistEntry.findMany({
    where: { confirmedAt: null, userId: null, createdAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: WAITLIST_RETENTION_BATCH,
  });
  if (due.length === 0) return { unconfirmedDeleted: 0 };

  const ids = due.map((e) => e.id);
  const deleted = await prisma.$transaction(async (tx) => {
    // Re-checked in the delete: an entry confirmed since the read is kept.
    const { count } = await tx.waitlistEntry.deleteMany({
      where: { id: { in: ids }, confirmedAt: null, userId: null },
    });
    await tx.verification.deleteMany({ where: { identifier: { in: ids.map(confirmIdentifier) } } });
    return count;
  });

  logger.info('Waitlist retention: deleted unconfirmed entries', {
    deleted,
    windowDays: config.retention.unconfirmedDays,
  });
  return { unconfirmedDeleted: deleted };
}
