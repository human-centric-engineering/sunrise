/**
 * Deleting waitlist entries past their retention windows (§125 t-976).
 *
 * Every state has a limit (spec, *Privacy and invites → Retention*), each a
 * setting in the waitlist config (`retention`, defaults in
 * `DEFAULT_WAITLIST_RETENTION`):
 *
 *   • **Removed** — deleted `removedDays` (90) after its removal. That ends its
 *     "stays removed" protection, which is safe: a new entry for the address
 *     has to be confirmed by its owner (t-977).
 *   • **On a closed list** — a confirmed entry, not joined and not removed, is
 *     deleted `closedListMonths` (12) after the list closed. The close is the
 *     list's `WaitlistListState` row with `open: false`; its `changedAt` is
 *     when, and re-closing a closed list does not move it
 *     (`setWaitlistListOpen()`).
 *   • **Unconfirmed** — 30 days; t-977 adds it here.
 *   • **Joined** — linked to its account and erased with it; never here.
 *
 * Runs in one org (the maintenance job enters each in turn). These deletions
 * are retention, not erasure requests, so they write no receipt.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getWaitlistConfig, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WaitlistRetentionResult {
  removedDeleted: number;
  closedListDeleted: number;
}

/** `months` calendar months before `now`, in UTC. */
function monthsBefore(now: Date, months: number): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/** Delete this org's waitlist entries that have outlived their window. */
export async function pruneWaitlistEntries(
  config: ResolvedWaitlistConfig,
  now: Date = new Date()
): Promise<WaitlistRetentionResult> {
  const removedCutoff = new Date(now.getTime() - config.retention.removedDays * DAY_MS);
  const removed = await prisma.waitlistEntry.deleteMany({
    where: { removedAt: { lt: removedCutoff } },
  });

  const closedCutoff = monthsBefore(now, config.retention.closedListMonths);
  const closedLists = await prisma.waitlistListState.findMany({
    where: { open: false, changedAt: { lt: closedCutoff } },
    select: { list: true },
  });
  const closed =
    closedLists.length === 0
      ? { count: 0 }
      : await prisma.waitlistEntry.deleteMany({
          where: {
            list: { in: closedLists.map((l) => l.list) },
            confirmedAt: { not: null },
            joinedAt: null,
            removedAt: null,
          },
        });

  return { removedDeleted: removed.count, closedListDeleted: closed.count };
}

/**
 * The maintenance job's entry point (`waitlistRetention`, per org): a no-op
 * while the app has no waitlist, so an install with the scaffold empty reads
 * nothing.
 */
export async function runWaitlistRetention(
  now: Date = new Date()
): Promise<WaitlistRetentionResult> {
  const config = getWaitlistConfig();
  if (!config) return { removedDeleted: 0, closedListDeleted: 0 };
  const result = await pruneWaitlistEntries(config, now);
  if (result.removedDeleted > 0 || result.closedListDeleted > 0) {
    logger.info('Waitlist retention deleted entries', { ...result });
  }
  return result;
}
