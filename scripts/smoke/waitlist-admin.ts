/**
 * Smoke: the admin waitlist against a real database (§125 t-976).
 *
 *   npm run smoke:waitlist-admin
 *
 * What the unit tests cannot show, because they mock Prisma:
 *
 *   • **Retention deletes only what has outlived its window.** It seeds each
 *     population — expired and in-window removed entries, a removed entry
 *     that signed up, a long-closed list's confirmed, joined, recently
 *     invited, removed-recently and unconfirmed entries, a recently closed
 *     list's and an open list's — shows each is non-empty, prunes, and checks
 *     exactly the expired rows went.
 *   • The admin search's JSON-path match on a declared answer, the per-org
 *     list-state upsert (`orgId_list`), and the counts' groupings, as Postgres
 *     runs them.
 *
 * Runs in the install org. It refuses to prune if the table already holds an
 * expired entry it did not create: the prune is org-wide, and this script
 * deletes only its own rows. Self-cleaning by tracked id.
 */

import { prisma } from '@/lib/db/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import { DEFAULT_WAITLIST_RETENTION, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';
import {
  countWaitlistEntries,
  listWaitlistEntries,
  setWaitlistListOpen,
} from '@/lib/waitlist/admin';
import {
  expiredRemovedWhere,
  pruneWaitlistEntries,
  waitlistRetentionCutoffs,
} from '@/lib/waitlist/retention';

const PREFIX = 'smoke-waitlist-admin';
const stamp = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const OPEN = `open${stamp}`;
const CLOSED_LONG = `closedlong${stamp}`;
const CLOSED_RECENT = `closedrecent${stamp}`;

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'smoke',
  fields: [{ key: 'useCase', label: 'Use case', kind: 'textarea' }],
  lists: [{ key: OPEN }, { key: CLOSED_LONG }, { key: CLOSED_RECENT }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
};

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:waitlist-admin skipped — no database reachable.');
    return;
  }
  const entryIds: string[] = [];
  const lists = [OPEN, CLOSED_LONG, CLOSED_RECENT];
  let actorId: string | null = null;

  try {
    // Anyone else's expired rows would be deleted by an org-wide prune: ask
    // the prune's own question, with its own cut-offs.
    const { removedBefore, closedBefore } = waitlistRetentionCutoffs(CONFIG.retention, NOW);
    const foreignExpired = await prisma.waitlistEntry.count({
      where: expiredRemovedWhere(removedBefore),
    });
    if (foreignExpired > 0) {
      throw new Error(
        `refusing to prune: ${foreignExpired} expired removed entr(ies) not created by this script`
      );
    }
    // …and so would a list someone else closed over the window ago.
    const foreignClosed = await prisma.waitlistListState.count({
      where: { open: false, changedAt: { lt: closedBefore } },
    });
    if (foreignClosed > 0) {
      throw new Error(
        `refusing to prune: ${foreignClosed} long-closed list(s) not created by this script`
      );
    }

    const actor = await prisma.user.create({
      data: {
        name: `${PREFIX} admin`,
        email: `${PREFIX}-${stamp}@example.com`,
        emailVerified: true,
      },
    });
    actorId = actor.id;

    const make = async (
      label: string,
      list: string,
      fields: {
        confirmedAt?: Date | null;
        removedAt?: Date | null;
        joinedAt?: Date | null;
        invitedAt?: Date | null;
      } = {},
      details: Record<string, string> = {}
    ) => {
      const row = await prisma.waitlistEntry.create({
        data: {
          email: `${PREFIX}-${label}-${stamp}@example.com`,
          list,
          details,
          consentedAt: ago(400),
          consentVersion: 'smoke',
          confirmedAt: fields.confirmedAt === undefined ? ago(399) : fields.confirmedAt,
          removedAt: fields.removedAt ?? null,
          joinedAt: fields.joinedAt ?? null,
          invitedAt: fields.invitedAt ?? null,
        },
      });
      entryIds.push(row.id);
      return row.id;
    };

    const expiredRemoved = await make('removed-old', OPEN, { removedAt: ago(91) });
    const recentRemoved = await make('removed-new', OPEN, { removedAt: ago(10) });
    const openConfirmed = await make('open', OPEN, {}, { useCase: `modular synth ${stamp}` });
    const longClosedConfirmed = await make('closed-confirmed', CLOSED_LONG);
    const longClosedJoined = await make('closed-joined', CLOSED_LONG, { joinedAt: ago(30) });
    const longClosedUnconfirmed = await make('closed-unconfirmed', CLOSED_LONG, {
      confirmedAt: null,
    });
    const longClosedRemovedRecently = await make('closed-removed', CLOSED_LONG, {
      removedAt: ago(5),
    });
    const recentClosedConfirmed = await make('recent-closed', CLOSED_RECENT);
    // Removed long ago but signed up: the account's, never retention's.
    const removedJoined = await make('removed-joined', OPEN, {
      removedAt: ago(200),
      joinedAt: ago(150),
    });
    // On the long-closed list, invited yesterday: its link may be live.
    const longClosedInvited = await make('closed-invited', CLOSED_LONG, { invitedAt: ago(1) });

    // Close one list 13 months ago and one last month, through the real write.
    await setWaitlistListOpen(CLOSED_LONG, false, actor.id, ago(400));
    await setWaitlistListOpen(CLOSED_RECENT, false, actor.id, ago(30));
    // Closing a closed list again does not move its clock.
    const again = await setWaitlistListOpen(CLOSED_LONG, false, actor.id, NOW);
    check(
      again.changedAt.getTime() === ago(400).getTime(),
      're-closing a closed list keeps its closedAt'
    );

    // The search's JSON-path match on a declared answer, as Postgres runs it.
    const found = await listWaitlistEntries(CONFIG, {
      q: `synth ${stamp}`,
      page: 1,
      limit: 25,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
    check(
      found.total === 1 && found.entries[0]?.id === openConfirmed,
      'search finds an entry by a declared answer'
    );

    const counts = await countWaitlistEntries(CONFIG);
    const byKey = new Map(counts.map((c) => [c.key, c]));
    check(byKey.get(CLOSED_LONG)?.open === false, 'a closed list counts as closed');
    check(
      byKey.get(CLOSED_LONG)?.confirmed === 2 && byKey.get(CLOSED_LONG)?.unconfirmed === 1,
      'counts keep confirmed and unconfirmed apart'
    );

    // The population, non-empty before the prune.
    const present = async (ids: string[]) =>
      prisma.waitlistEntry.count({ where: { id: { in: ids } } });
    const doomed = [expiredRemoved, longClosedConfirmed];
    const kept = [
      recentRemoved,
      openConfirmed,
      longClosedJoined,
      longClosedUnconfirmed,
      longClosedRemovedRecently,
      recentClosedConfirmed,
      removedJoined,
      longClosedInvited,
    ];
    check((await present(doomed)) === doomed.length, `the ${doomed.length} expired entries exist`);
    check((await present(kept)) === kept.length, `the ${kept.length} in-window entries exist`);

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    check(
      result.removedDeleted === 1 && result.closedListDeleted === 1,
      'the prune reports one removed and one closed-list deletion'
    );
    check((await present(doomed)) === 0, 'both expired entries are gone');
    check((await present(kept)) === kept.length, 'every in-window entry is still there');

    console.log('\n✓ smoke:waitlist-admin passed');
  } finally {
    await prisma.waitlistEntry
      .deleteMany({ where: { id: { in: entryIds } } })
      .catch(() => undefined);
    await prisma.waitlistListState
      .deleteMany({ where: { list: { in: lists } } })
      .catch(() => undefined);
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } }).catch(() => undefined);
  }
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' })
  .catch((err: unknown) => {
    console.error('\n✗ smoke:waitlist-admin failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
