/**
 * Putting someone on a waitlist (§125).
 *
 * Called inside the org the entry belongs to (the join route enters the
 * install org); the data layer stamps `orgId` on the create and, at `multi`,
 * confines every read and write here to that org.
 *
 * The rules, each re-derived for an unverified public form (spec, "Rules
 * carried over from Lelanea"):
 *
 *   • **Before confirmation, a repeat replaces the answers.** Nothing has been
 *     proved yet, and a stranger's guesses should not outlive the owner's own.
 *   • **After confirmation, a repeat only fills empty answers.** It never
 *     overwrites one: nothing proves the second submitter owns the address.
 *   • **`consentedAt` never moves.** It records when the person joined under
 *     the notice; a repeat is not a new consent.
 *   • **A removed entry stays removed.** A re-join is counted
 *     (`rejoinRequests`, `rejoinRequestedAt`) and nothing else changes, so a
 *     stranger cannot undo someone else's removal by joining again.
 *   • **A flag sticks.** A repeat never clears `flaggedReason`; a clean second
 *     submission from a different IP is not evidence the first was fine.
 *
 * Whatever happens here, the caller answers the joiner the same way; the
 * outcome is for the log line and the tests.
 */

import { prisma } from '@/lib/db/client';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { logger } from '@/lib/logging';
import { isRecord } from '@/lib/utils';
import type { ResolvedWaitlistConfig } from '@/lib/waitlist/config';

/** One validated join. */
export interface WaitlistJoin {
  /** Already trimmed and lower-cased (`emailSchema`). */
  email: string;
  name: string | null;
  list: string;
  details: Readonly<Record<string, string>>;
  source: string;
  locale: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  referrerHost: string | null;
  /** Shown to `screen()`; never stored. */
  ip: string | null;
}

/** What a join did. The joiner is never told. */
export type WaitlistJoinOutcome =
  /** A new, unconfirmed entry. */
  | 'created'
  /** An unconfirmed entry's answers were replaced. */
  | 'replaced'
  /** A confirmed entry's empty answers were filled. */
  | 'filled'
  /** A confirmed entry had nothing empty to fill. */
  | 'unchanged'
  /** A removed entry; the attempt was counted. */
  | 'rejoin-counted';

/** What a join did, and to which entry (for the email sent after it). */
export interface WaitlistJoinResult {
  outcome: WaitlistJoinOutcome;
  entryId: string;
}

/** How many times a join re-reads after losing a race before it gives up. */
const ATTEMPTS = 3;

async function screen(config: ResolvedWaitlistConfig, join: WaitlistJoin): Promise<string | null> {
  if (!config.screen) return null;
  let result: unknown;
  try {
    result = await config.screen({
      email: join.email,
      name: join.name,
      list: join.list,
      details: join.details,
      ip: join.ip,
    });
  } catch (error) {
    // Held for review rather than accepted: a broken screen should not wave
    // everything through, and it should not lose the join either.
    logger.warn('Waitlist screen() threw; the entry is flagged', {
      list: join.list,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'screen-error';
  }
  // The fork's function, so its answer is checked like any other input: a
  // malformed one is a broken screen, and flags rather than losing the join.
  if (isRecord(result) && result.action === 'accept') return null;
  if (isRecord(result) && result.action === 'flag') {
    return typeof result.reason === 'string'
      ? result.reason.trim().slice(0, 200) || 'flagged'
      : 'flagged';
  }
  logger.warn('Waitlist screen() returned neither accept nor flag; the entry is flagged', {
    list: join.list,
  });
  return 'screen-error';
}

/** The stored answers, as strings. Anything else in the column is dropped. */
function storedAnswers(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(details)) return out;
  for (const [k, v] of Object.entries(details)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * Add `join` to its list, or apply it to the entry already there for that
 * address. Retries a lost race (a concurrent first join, or a concurrent
 * repeat) by re-reading; throws only if it keeps losing.
 */
export async function joinWaitlist(
  config: ResolvedWaitlistConfig,
  join: WaitlistJoin,
  now: Date = new Date()
): Promise<WaitlistJoinResult> {
  const flaggedReason = await screen(config, join);

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const existing = await prisma.waitlistEntry.findFirst({
      where: { list: join.list, email: join.email },
      select: {
        id: true,
        name: true,
        details: true,
        confirmedAt: true,
        removedAt: true,
        flaggedReason: true,
        updatedAt: true,
      },
    });

    if (!existing) {
      try {
        const created = await prisma.waitlistEntry.create({
          select: { id: true },
          data: {
            email: join.email,
            name: join.name,
            list: join.list,
            details: join.details,
            source: join.source,
            locale: join.locale,
            utmSource: join.utmSource,
            utmMedium: join.utmMedium,
            utmCampaign: join.utmCampaign,
            referrerHost: join.referrerHost,
            consentedAt: now,
            consentVersion: config.consentVersion,
            flaggedReason,
          },
        });
        return { outcome: 'created', entryId: created.id };
      } catch (error) {
        // Someone joined with the same address between the read and the
        // create; re-read and treat this one as their repeat.
        if (isUniqueViolationOn(error, UNIQUE_CONSTRAINTS.waitlistEntryEmail)) continue;
        throw error;
      }
    }

    if (existing.removedAt) {
      const { count } = await prisma.waitlistEntry.updateMany({
        where: { id: existing.id, removedAt: { not: null } },
        data: { rejoinRequests: { increment: 1 }, rejoinRequestedAt: now },
      });
      if (count === 1) return { outcome: 'rejoin-counted', entryId: existing.id };
      continue;
    }

    if (!existing.confirmedAt) {
      const { count } = await prisma.waitlistEntry.updateMany({
        where: { id: existing.id, confirmedAt: null, removedAt: null },
        data: {
          name: join.name,
          details: join.details,
          flaggedReason: existing.flaggedReason ?? flaggedReason,
        },
      });
      if (count === 1) return { outcome: 'replaced', entryId: existing.id };
      continue;
    }

    // Confirmed: fill only what is empty. Conditional on the row being as read,
    // so two concurrent repeats cannot both "fill" the same answer.
    //
    // The repeat's screen() verdict is deliberately not applied here. The
    // owner has proved the address; a stranger re-submitting it from a
    // suspicious IP must not be able to flag the owner's entry and so hold it
    // out of bulk invites. Before confirmation nothing is proved, so a flag
    // from any submission stands (above).
    const stored = storedAnswers(existing.details);
    // Own keys only: a field keyed `constructor` must not read the prototype.
    const added = Object.entries(join.details).filter(([k]) => !Object.hasOwn(stored, k));
    const fillName = existing.name === null && join.name !== null;
    if (added.length === 0 && !fillName) return { outcome: 'unchanged', entryId: existing.id };
    const { count } = await prisma.waitlistEntry.updateMany({
      where: { id: existing.id, updatedAt: existing.updatedAt, removedAt: null },
      data: {
        ...(fillName ? { name: join.name } : {}),
        details: { ...stored, ...Object.fromEntries(added) },
      },
    });
    if (count === 1) return { outcome: 'filled', entryId: existing.id };
  }

  throw new Error(`Waitlist join lost ${ATTEMPTS} races in a row`);
}
