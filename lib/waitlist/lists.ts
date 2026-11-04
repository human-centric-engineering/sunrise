/**
 * Whether a waitlist list is taking joins (§125).
 *
 * A list with no `WaitlistListState` row is in the state the fork's config
 * starts it in; once an admin has opened or closed it, the row wins. Read in
 * the current org's scope: the row is tenant-owned, so at `multi` the policy
 * confines the read to the org the caller entered.
 *
 * Closing a list stops new joins and nothing else. Confirming, leaving,
 * invites, export and erasure never read this.
 */

import { prisma } from '@/lib/db/client';
import type { ResolvedWaitlistConfig } from '@/lib/waitlist/config';

export interface WaitlistListStatus {
  key: string;
  open: boolean;
}

/** A list's state for the admin: open or not, and since when it is closed. */
export interface WaitlistListState extends WaitlistListStatus {
  /**
   * When an admin closed it, if it is closed and that was recorded. Null for
   * an open list, and for one closed only by the config (`startsClosed`):
   * that list has no close date, so retention has no window to count.
   */
  closedSince: Date | null;
}

/**
 * Every declared list's state, in declaration order. The one place the rule
 * lives: a stored row wins, and without one the config's starting state.
 */
export async function getWaitlistListStates(
  config: ResolvedWaitlistConfig
): Promise<WaitlistListState[]> {
  const keys = config.lists.map((l) => l.key);
  const rows = await prisma.waitlistListState.findMany({
    where: { list: { in: keys } },
    select: { list: true, open: true, changedAt: true },
  });
  const stored = new Map(rows.map((r) => [r.list, r]));
  return config.lists.map((l) => {
    const row = stored.get(l.key);
    return {
      key: l.key,
      open: row?.open ?? !l.startsClosed,
      closedSince: row && !row.open ? row.changedAt : null,
    };
  });
}

/**
 * Every declared list and whether it is open, in declaration order — the
 * public answer: no close date, which is the admin's.
 */
export async function getWaitlistListStatuses(
  config: ResolvedWaitlistConfig
): Promise<WaitlistListStatus[]> {
  return (await getWaitlistListStates(config)).map(({ key, open }) => ({ key, open }));
}

/** Whether one declared list is open. A key the config does not declare is never open. */
export async function isWaitlistListOpen(
  config: ResolvedWaitlistConfig,
  list: string
): Promise<boolean> {
  const declared = config.lists.find((l) => l.key === list);
  if (!declared) return false;
  const row = await prisma.waitlistListState.findFirst({
    where: { list },
    select: { open: true },
  });
  return row?.open ?? !declared.startsClosed;
}
