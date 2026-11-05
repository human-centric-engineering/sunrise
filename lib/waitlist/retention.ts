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
 *     date; the admin page offers "Mark closed", which records one, and the
 *     window runs from then.
 *   • **Unconfirmed** — deleted `unconfirmedDays` (30) after its
 *     `confirmWindowFrom` (t-977): its join, the latest confirmation link
 *     sent (a re-join sends a new link, and the entry must outlive it), or an
 *     admin restore. The window is at least the link's seven days. Nothing
 *     proves the address is the person's own, so it is not kept for long, and
 *     the link cap (`WAITLIST_CONFIRM_MAX_LINKS`) stops resubmissions from
 *     keeping it forever. A removed entry waits out the removed window instead, so its
 *     "stays removed" protection is not cut short; an entry linked to an
 *     account is never deleted here.
 *   • **Joined** — linked to its account and erased with it; never here, also
 *     when an admin has removed it.
 *
 * Each prune deletes in batches of {@link WAITLIST_RETENTION_BATCH}, up to
 * {@link WAITLIST_RETENTION_MAX_BATCHES} a run and within
 * {@link WAITLIST_RETENTION_BUDGET_MS} for the whole run, shared fairly: each
 * prune gets an equal part of what is left when it starts, so a backlog in
 * one window cannot hold up the others. Short statements
 * rather than one long delete inside the shared maintenance tick, and a
 * backlog of up to 20,000 rows still goes in the run that finds it rather
 * than over hours past its window. A bigger one, or one the time budget cuts
 * short, drains over the following hourly runs.
 * Runs in one org (the maintenance job enters each in turn). These deletions
 * are retention, not erasure requests, so they write no receipt. A deleted
 * entry's outstanding confirmation tokens go with it, by the cascade.
 *
 * **The windows hold with no config too.** A fork that drops its waitlist
 * config still has the rows it collected, and its privacy notice still
 * promised their limits, so the job prunes them on the default windows. An
 * org with no entries costs one read.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  DEFAULT_WAITLIST_RETENTION,
  getWaitlistConfig,
  type ResolvedWaitlistConfig,
} from '@/lib/waitlist/config';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows per delete statement. */
export const WAITLIST_RETENTION_BATCH = 1000;
/** Batches per prune per run. */
export const WAITLIST_RETENTION_MAX_BATCHES = 20;
/**
 * Time one org's run may spend, all three prunes together. The tick runs every
 * job for every org; this keeps a large backlog in one org from taking it.
 */
export const WAITLIST_RETENTION_BUDGET_MS = 15_000;

/**
 * Delete what `where` matches, a batch at a time, until a batch comes back
 * short, the run's batch cap is reached, or `deadline` passes.
 */
async function deleteInBatches(
  where: Prisma.WaitlistEntryWhereInput,
  deadline: number
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < WAITLIST_RETENTION_MAX_BATCHES; batch += 1) {
    if (Date.now() >= deadline) break;
    // No order: any expired row will do, and an unordered read can stop at
    // the batch size rather than sort every match first.
    const rows = await prisma.waitlistEntry.findMany({
      where,
      select: { id: true },
      take: WAITLIST_RETENTION_BATCH,
    });
    if (rows.length === 0) break;
    // The same where again: a row that changed between the read and the
    // delete (restored, joined, re-invited) is not deleted for the state it left.
    // Each deleted entry's confirmation tokens cascade with it; one kept by
    // the re-check keeps its links.
    const deleted = await prisma.waitlistEntry.deleteMany({
      where: { AND: [where, { id: { in: rows.map((r) => r.id) } }] },
    });
    total += deleted.count;
    // A short batch was the last; a batch that deleted nothing would read
    // the same rows again.
    if (rows.length < WAITLIST_RETENTION_BATCH || deleted.count === 0) break;
  }
  return total;
}

export interface WaitlistRetentionResult {
  unconfirmedDeleted: number;
  removedDeleted: number;
  closedListDeleted: number;
}

/** `months` calendar months before `now`, in UTC. */
function monthsBefore(now: Date, months: number): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/** The cut-offs a run at `now` uses: joined before, removed before, and closed before. */
export function waitlistRetentionCutoffs(
  retention: ResolvedWaitlistConfig['retention'],
  now: Date
): { unconfirmedBefore: Date; removedBefore: Date; closedBefore: Date } {
  return {
    unconfirmedBefore: new Date(now.getTime() - retention.unconfirmedDays * DAY_MS),
    removedBefore: new Date(now.getTime() - retention.removedDays * DAY_MS),
    closedBefore: monthsBefore(now, retention.closedListMonths),
  };
}

/** The list states whose lists the closed-list prune reaches: closed before the cut-off. */
export function longClosedListWhere(closedBefore: Date): Prisma.WaitlistListStateWhereInput {
  return { open: false, changedAt: { lt: closedBefore } };
}

/** The entries the unconfirmed-entry prune deletes. */
export function expiredUnconfirmedWhere(unconfirmedBefore: Date): Prisma.WaitlistEntryWhereInput {
  return {
    confirmedAt: null,
    // A linked entry is the account's, erased with it.
    userId: null,
    // A removed one keeps its "stays removed" protection for the removed window.
    removedAt: null,
    // Moved by every link sent, so a link sent since the cut-off, which may
    // still be live, keeps its entry.
    confirmWindowFrom: { lt: unconfirmedBefore },
  };
}

/** The entries the removed-entry prune deletes. */
export function expiredRemovedWhere(removedBefore: Date): Prisma.WaitlistEntryWhereInput {
  // A joined entry is the account's, erased with it.
  return { removedAt: { lt: removedBefore }, joinedAt: null };
}

/** Delete this org's waitlist entries that have outlived their window. */
export async function pruneWaitlistEntries(
  retention: ResolvedWaitlistConfig['retention'],
  now: Date = new Date()
): Promise<WaitlistRetentionResult> {
  const {
    unconfirmedBefore,
    removedBefore,
    closedBefore: closedCutoff,
  } = waitlistRetentionCutoffs(retention, now);
  const end = Date.now() + WAITLIST_RETENTION_BUDGET_MS;
  // An equal part of what is left, for a prune with `prunesLeft` to go
  // (itself included): time one does not use passes to the next.
  const shareOf = (prunesLeft: number): number =>
    Date.now() + Math.max(0, end - Date.now()) / prunesLeft;
  const unconfirmedDeleted = await deleteInBatches(
    expiredUnconfirmedWhere(unconfirmedBefore),
    shareOf(3)
  );
  const removedDeleted = await deleteInBatches(expiredRemovedWhere(removedBefore), shareOf(2));

  const closedLists = await prisma.waitlistListState.findMany({
    where: longClosedListWhere(closedCutoff),
    select: { list: true },
  });
  const closedListDeleted =
    closedLists.length === 0
      ? 0
      : await deleteInBatches(
          {
            list: { in: closedLists.map((l) => l.list) },
            confirmedAt: { not: null },
            joinedAt: null,
            removedAt: null,
            // Invites go on after a close: one sent since the cut-off may
            // still be a live sign-up link.
            OR: [{ invitedAt: null }, { invitedAt: { lt: closedCutoff } }],
          },
          shareOf(1)
        );

  return { unconfirmedDeleted, removedDeleted, closedListDeleted };
}

/**
 * The maintenance job's entry point (`waitlistRetention`, per org). With no
 * config it prunes on the default windows (module comment), after one read
 * that finds whether the org holds any entries at all — so an install that
 * never had a waitlist reads one empty table and nothing else.
 */
export async function runWaitlistRetention(
  now: Date = new Date()
): Promise<WaitlistRetentionResult> {
  const config = getWaitlistConfig();
  if (!config) {
    const any = await prisma.waitlistEntry.findFirst({ select: { id: true } });
    if (!any) return { unconfirmedDeleted: 0, removedDeleted: 0, closedListDeleted: 0 };
  }
  const result = await pruneWaitlistEntries(config?.retention ?? DEFAULT_WAITLIST_RETENTION, now);
  if (result.unconfirmedDeleted > 0 || result.removedDeleted > 0 || result.closedListDeleted > 0) {
    logger.info('Waitlist retention deleted entries', { ...result });
  }
  return result;
}
