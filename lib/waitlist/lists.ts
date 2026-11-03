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

/** Every declared list and whether it is open, in declaration order. */
export async function getWaitlistListStatuses(
  config: ResolvedWaitlistConfig
): Promise<WaitlistListStatus[]> {
  const keys = config.lists.map((l) => l.key);
  const rows = await prisma.waitlistListState.findMany({
    where: { list: { in: keys } },
    select: { list: true, open: true },
  });
  const stored = new Map(rows.map((r) => [r.list, r.open]));
  return config.lists.map((l) => ({
    key: l.key,
    open: stored.get(l.key) ?? !l.startsClosed,
  }));
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
