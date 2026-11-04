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
 *     (`setWaitlistListOpen()`). Inviting goes on after a close, so an entry
 *     invited since the cut-off is kept: its sign-up link may still be live.
 *     A list closed only by the config (`startsClosed`, no row) has no close
 *     date, and is not pruned until an admin closes it on the page.
 *   • **Unconfirmed** — 30 days; t-977 adds it here.
 *   • **Joined** — linked to its account and erased with it; never here, also
 *     when an admin has removed it.
 *
 * Each prune deletes at most {@link WAITLIST_RETENTION_BATCH} rows a run, as
 * the other retention prunes are capped: a backlog drains over the hourly
 * runs rather than as one long delete inside the tick, and a full batch
 * reports work so the idle gate looks again.
 * Runs in one org (the maintenance job enters each in turn). These deletions
 * are retention, not erasure requests, so they write no receipt.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getWaitlistConfig, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most rows each prune deletes in one run. */
export const WAITLIST_RETENTION_BATCH = 1000;

/** Delete up to one batch of the rows `where` matches, oldest first. */
async function deleteBatch(where: Prisma.WaitlistEntryWhereInput): Promise<number> {
  const rows = await prisma.waitlistEntry.findMany({
    where,
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: WAITLIST_RETENTION_BATCH,
  });
  if (rows.length === 0) return 0;
  // The same where again: a row that changed between the read and the delete
  // (restored, joined, re-invited) is not deleted for the state it left.
  const deleted = await prisma.waitlistEntry.deleteMany({
    where: { AND: [where, { id: { in: rows.map((r) => r.id) } }] },
  });
  return deleted.count;
}

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
  const removedDeleted = await deleteBatch({
    removedAt: { lt: removedCutoff },
    // A joined entry is the account's, erased with it.
    joinedAt: null,
  });

  const closedCutoff = monthsBefore(now, config.retention.closedListMonths);
  const closedLists = await prisma.waitlistListState.findMany({
    where: { open: false, changedAt: { lt: closedCutoff } },
    select: { list: true },
  });
  const closedListDeleted =
    closedLists.length === 0
      ? 0
      : await deleteBatch({
          list: { in: closedLists.map((l) => l.list) },
          confirmedAt: { not: null },
          joinedAt: null,
          removedAt: null,
          // Invites go on after a close: one sent since the cut-off may
          // still be a live sign-up link.
          OR: [{ invitedAt: null }, { invitedAt: { lt: closedCutoff } }],
        });

  return { removedDeleted, closedListDeleted };
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
