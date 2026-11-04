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
 *   • **Unconfirmed** — deleted `unconfirmedDays` (30) after it joined
 *     (t-977). Nothing proves the address is the person's own, so it is not
 *     kept for long. An entry linked to an account is never deleted here.
 *   • **Joined** — linked to its account and erased with it; never here, also
 *     when an admin has removed it.
 *
 * Each prune deletes in batches of {@link WAITLIST_RETENTION_BATCH}, up to
 * {@link WAITLIST_RETENTION_MAX_BATCHES} a run and within
 * {@link WAITLIST_RETENTION_BUDGET_MS} for the whole run: short statements
 * rather than one long delete inside the shared maintenance tick, and a
 * backlog of up to 20,000 rows still goes in the run that finds it rather
 * than over hours past its window. A bigger one, or one the time budget cuts
 * short, drains over the following hourly runs.
 * Runs in one org (the maintenance job enters each in turn). These deletions
 * are retention, not erasure requests, so they write no receipt. A deleted
 * entry's outstanding confirmation token goes with it, in the same
 * transaction.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getWaitlistConfig, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';
import { confirmIdentifier } from '@/lib/waitlist/tokens';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows per delete statement. */
export const WAITLIST_RETENTION_BATCH = 1000;
/** Batches per prune per run. */
export const WAITLIST_RETENTION_MAX_BATCHES = 20;
/**
 * Time one org's run may spend, both prunes together. The tick runs every
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
    const ids = rows.map((r) => r.id);
    const deleted = await prisma.$transaction(async (tx) => {
      const result = await tx.waitlistEntry.deleteMany({
        where: { AND: [where, { id: { in: ids } }] },
      });
      // Only the entries actually gone lose their confirmation token: one
      // that changed state since the read is kept, and keeps its link.
      if (result.count > 0) {
        const kept = await tx.waitlistEntry.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        });
        const keptIds = new Set(kept.map((k) => k.id));
        await tx.verification.deleteMany({
          where: {
            identifier: { in: ids.filter((id) => !keptIds.has(id)).map(confirmIdentifier) },
          },
        });
      }
      return result;
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
  // A linked entry is the account's, erased with it.
  return { confirmedAt: null, userId: null, createdAt: { lt: unconfirmedBefore } };
}

/** The entries the removed-entry prune deletes. */
export function expiredRemovedWhere(removedBefore: Date): Prisma.WaitlistEntryWhereInput {
  // A joined entry is the account's, erased with it.
  return { removedAt: { lt: removedBefore }, joinedAt: null };
}

/** Delete this org's waitlist entries that have outlived their window. */
export async function pruneWaitlistEntries(
  config: ResolvedWaitlistConfig,
  now: Date = new Date()
): Promise<WaitlistRetentionResult> {
  const {
    unconfirmedBefore,
    removedBefore,
    closedBefore: closedCutoff,
  } = waitlistRetentionCutoffs(config.retention, now);
  const deadline = Date.now() + WAITLIST_RETENTION_BUDGET_MS;
  const unconfirmedDeleted = await deleteInBatches(
    expiredUnconfirmedWhere(unconfirmedBefore),
    deadline
  );
  const removedDeleted = await deleteInBatches(expiredRemovedWhere(removedBefore), deadline);

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
          deadline
        );

  return { unconfirmedDeleted, removedDeleted, closedListDeleted };
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
  if (!config) return { unconfirmedDeleted: 0, removedDeleted: 0, closedListDeleted: 0 };
  const result = await pruneWaitlistEntries(config, now);
  if (result.unconfirmedDeleted > 0 || result.removedDeleted > 0 || result.closedListDeleted > 0) {
    logger.info('Waitlist retention deleted entries', { ...result });
  }
  return result;
}
