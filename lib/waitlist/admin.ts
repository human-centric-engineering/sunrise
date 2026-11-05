/**
 * What the admin running a launch does with the waitlist (§125 t-976): read
 * and search it, count it, take someone off it, and open or close a list.
 * Erasure is `eraseWaitlistEntry()` (`lib/waitlist/erase.ts`); the routes
 * under `app/api/v1/admin/waitlist/` call these.
 *
 * Everything here runs in the caller's org (`runAsOrg`, entered by the admin
 * guard): both tables are tenant-owned, so at `multi` the policy confines each
 * read and write to that org's rows.
 *
 * **Unconfirmed entries do not count** (spec, *Confirming the address*). The
 * list hides them unless asked, the counts report them on their own line and
 * never inside "confirmed", and the export leaves them out unless asked. A
 * flagged entry is shown (it is there to be reviewed) but kept out of the
 * confirmed count. Until t-977 lands nothing confirms an entry, so on a live
 * install every entry is unconfirmed.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireOrgId } from '@/lib/tenancy/context';
import type { ResolvedWaitlistConfig } from '@/lib/waitlist/config';
import { revokeEntryInvitations } from '@/lib/waitlist/invitations';
import { getWaitlistListStates } from '@/lib/waitlist/lists';

/** Which entries a list or export shows beyond the default (confirmed, active). */
export interface WaitlistEntryFilter {
  /** One declared list; all of them when absent. */
  list?: string;
  /** Matches the address, the name, or any declared answer (a text match). */
  q?: string;
  includeUnconfirmed?: boolean;
  includeRemoved?: boolean;
  includeJoined?: boolean;
  /** Only flagged entries. */
  flaggedOnly?: boolean;
}

export type WaitlistSortField = 'createdAt' | 'email' | 'confirmedAt';

export interface WaitlistListQuery extends WaitlistEntryFilter {
  page: number;
  limit: number;
  sortBy: WaitlistSortField;
  sortOrder: 'asc' | 'desc';
}

/** The fields an admin sees for one entry. No IP: the join never stores one. */
export const WAITLIST_ENTRY_SELECT = {
  id: true,
  email: true,
  name: true,
  list: true,
  details: true,
  source: true,
  locale: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  referrerHost: true,
  consentedAt: true,
  consentVersion: true,
  flaggedReason: true,
  confirmedAt: true,
  removedAt: true,
  rejoinRequestedAt: true,
  rejoinRequests: true,
  invitedAt: true,
  joinedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WaitlistEntrySelect;

export type AdminWaitlistEntry = Prisma.WaitlistEntryGetPayload<{
  select: typeof WAITLIST_ENTRY_SELECT;
}>;

/**
 * The `where` for a filter. The address is matched as typed against the
 * stored, lower-cased form — `contains`, which Prisma escapes, never
 * `mode: 'insensitive'` on the address (#766). The name is matched
 * case-insensitively; each declared answer by a JSON-path text match, which is
 * the cost of keeping answers in one column (spec, *Seams*).
 */
export function waitlistEntryWhere(
  config: ResolvedWaitlistConfig,
  filter: WaitlistEntryFilter
): Prisma.WaitlistEntryWhereInput {
  const declared = config.lists.map((l) => l.key);
  const and: Prisma.WaitlistEntryWhereInput[] = [
    // Only declared lists, also when one is asked for by name: a list the
    // config no longer declares is not the admin's to page.
    {
      list: {
        in: filter.list !== undefined ? declared.filter((k) => k === filter.list) : declared,
      },
    },
  ];
  if (!filter.includeUnconfirmed) and.push({ confirmedAt: { not: null } });
  if (!filter.includeRemoved) and.push({ removedAt: null });
  if (!filter.includeJoined) and.push({ joinedAt: null });
  if (filter.flaggedOnly) and.push({ flaggedReason: { not: null } });

  const q = filter.q?.trim();
  if (q) {
    and.push({
      OR: [
        { email: { contains: q.toLowerCase() } },
        { name: { contains: q, mode: 'insensitive' } },
        ...config.fields.map((f): Prisma.WaitlistEntryWhereInput => ({
          details: { path: [f.key], string_contains: q },
        })),
      ],
    });
  }
  return { AND: and };
}

/** One page of entries, newest first by default, `id` breaking ties. */
export async function listWaitlistEntries(
  config: ResolvedWaitlistConfig,
  query: WaitlistListQuery
): Promise<{ entries: AdminWaitlistEntry[]; total: number }> {
  const where = waitlistEntryWhere(config, query);
  const [entries, total] = await Promise.all([
    prisma.waitlistEntry.findMany({
      where,
      select: WAITLIST_ENTRY_SELECT,
      // `id` last: two rows with the same timestamp keep one order across
      // pages, so paging never repeats or skips a row.
      orderBy: [{ [query.sortBy]: query.sortOrder }, { id: query.sortOrder }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.waitlistEntry.count({ where }),
  ]);
  return { entries, total };
}

export interface WaitlistListCounts {
  key: string;
  open: boolean;
  /**
   * When an admin closed it, if it is closed and that was recorded. Null for
   * an open list, and for one closed only by the config (`startsClosed`):
   * that list has no close date, so retention has no window to count until
   * one is recorded.
   */
  closedSince: Date | null;
  /** Confirmed, on the list, not flagged: the people an invite wave draws from. */
  confirmed: number;
  /** Not yet confirmed (and not removed or joined). Never inside `confirmed`. */
  unconfirmed: number;
  /** Flagged by the config's `screen()`, not removed or joined. */
  flagged: number;
  removed: number;
  invited: number;
  joined: number;
  /** `confirmed`, split by where the join came from (`utmSource`, else `source`). */
  bySource: Array<{ source: string; count: number }>;
}

/** Counts by state and by source for every declared list (spec, *What waitlist products offer*). */
export async function countWaitlistEntries(
  config: ResolvedWaitlistConfig
): Promise<WaitlistListCounts[]> {
  const statuses = await getWaitlistListStates(config);
  const keys = statuses.map((s) => s.key);
  const active = { list: { in: keys }, removedAt: null, joinedAt: null };

  const [confirmed, unconfirmed, flagged, removed, invited, joined, sources] = await Promise.all([
    groupCount({ ...active, confirmedAt: { not: null }, flaggedReason: null }),
    groupCount({ ...active, confirmedAt: null }),
    groupCount({ ...active, flaggedReason: { not: null } }),
    groupCount({ list: { in: keys }, removedAt: { not: null } }),
    groupCount({ ...active, invitedAt: { not: null } }),
    groupCount({ list: { in: keys }, joinedAt: { not: null } }),
    prisma.waitlistEntry.groupBy({
      by: ['list', 'utmSource', 'source'],
      where: { ...active, confirmedAt: { not: null }, flaggedReason: null },
      _count: { _all: true },
    }),
  ]);

  return statuses.map(({ key, open, closedSince }) => {
    const bySource = new Map<string, number>();
    for (const row of sources) {
      if (row.list !== key) continue;
      const label = row.utmSource ?? row.source;
      bySource.set(label, (bySource.get(label) ?? 0) + row._count._all);
    }
    return {
      key,
      open,
      closedSince,
      confirmed: confirmed.get(key) ?? 0,
      unconfirmed: unconfirmed.get(key) ?? 0,
      flagged: flagged.get(key) ?? 0,
      removed: removed.get(key) ?? 0,
      invited: invited.get(key) ?? 0,
      joined: joined.get(key) ?? 0,
      bySource: [...bySource]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    };
  });
}

async function groupCount(where: Prisma.WaitlistEntryWhereInput): Promise<Map<string, number>> {
  const rows = await prisma.waitlistEntry.groupBy({
    by: ['list'],
    where,
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.list, r._count._all]));
}

/**
 * Take an entry off the list, or put it back: `removed` is the state to reach,
 * so a double click or two admins at once land in the same place. Removing
 * keeps the row (`removedAt`, never a delete) and keeps an earlier removal's
 * time; a re-join while removed stays removed (`joinWaitlist()`). Restoring
 * clears `removedAt`, keeps the re-join count as history, and restarts an
 * unconfirmed entry's retention window (`confirmWindowFrom`): the admin chose
 * to keep it, and the prune must not undo that on its next run. Null when no
 * entry has that id in this org; `changed` is false when it was already in
 * that state, so the caller records only a change that happened.
 *
 * **Removing revokes the entry's invitations** (`revokeEntryInvitations()`):
 * someone taken off the list must not be able to sign up with a link sent
 * before. Run on every removal, a repeat included, so a revoke that failed
 * once is retried. Restoring sends nothing; the admin invites again.
 */
export async function setWaitlistEntryRemoved(
  id: string,
  removed: boolean,
  now: Date = new Date()
): Promise<{ entry: AdminWaitlistEntry; changed: boolean; invitationsRevoked: number } | null> {
  // Zero rows updated means already in that state, or no such entry; the
  // read after tells which.
  const { count } = await prisma.waitlistEntry.updateMany({
    where: removed ? { id, removedAt: null } : { id, removedAt: { not: null } },
    data: removed ? { removedAt: now } : { removedAt: null, confirmWindowFrom: now },
  });
  const entry = await prisma.waitlistEntry.findUnique({
    where: { id },
    select: WAITLIST_ENTRY_SELECT,
  });
  if (!entry) return null;
  const invitationsRevoked = removed ? await revokeEntryInvitations(entry.email, entry.id) : 0;
  return { entry, changed: count > 0, invitationsRevoked };
}

/**
 * Open or close a declared list in this org, recording who and when. The row
 * beats the config's starting state from then on, so a redeploy never
 * re-opens a list an admin closed. Closing stops new joins and nothing else.
 *
 * Asking for the state a stored row already has changes nothing — not even
 * `changedAt`, which dates a closed list's retention window: closing a closed
 * list again must not keep its entries longer.
 */
export async function setWaitlistListOpen(
  list: string,
  open: boolean,
  actorUserId: string,
  now: Date = new Date()
): Promise<{ key: string; open: boolean; changedAt: Date }> {
  const orgId = requireOrgId();
  const stored = await prisma.waitlistListState.findUnique({
    where: { orgId_list: { orgId, list } },
    select: { list: true, open: true, changedAt: true },
  });
  if (stored && stored.open === open) {
    return { key: stored.list, open: stored.open, changedAt: stored.changedAt };
  }
  const row = await prisma.waitlistListState.upsert({
    where: { orgId_list: { orgId, list } },
    create: { list, open, changedById: actorUserId, changedAt: now },
    update: { open, changedById: actorUserId, changedAt: now },
    select: { list: true, open: true, changedAt: true },
  });
  return { key: row.list, open: row.open, changedAt: row.changedAt };
}
