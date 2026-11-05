/**
 * Inviting people from the waitlist (§125 t-978).
 *
 * The point of a waitlist is letting people in. An invitation from the list is
 * an ordinary Sunrise invitation — issued and emailed by `deliverInvitation()`,
 * redeemed by accept-invite or the OAuth path — that also carries the entry's
 * id (`InvitationMetadata.waitlistEntryId`). The sign-up that redeems it links
 * the entry to the new account by that id (`linkWaitlistEntryToAccount()` in
 * `lib/waitlist/link.ts`, called from Sunrise's own after-hook), never by
 * matching the address.
 *
 * **Who can be invited.** A confirmed entry that is still on the list, not
 * flagged, not yet linked to an account, whose address has no account, and
 * for which no other invitation is pending. Anyone can type any address into
 * the form, so an unconfirmed entry is never invited; a flagged one is held
 * for a person to look at; a removed one was taken off by an admin and must be
 * restored first. The role is always `USER` and the org is always the entry's
 * own: nobody is made an admin, or put in another org, from a waitlist.
 *
 * **A pending invitation.** Invitations are install-wide and keyed by address,
 * one live per address. One this entry was sent is re-sent (a new link, a new
 * `invitedAt`); any other — from Admin → Users, or another org's list — is
 * someone else's and is left alone: the invite is refused.
 *
 * **`invitedAt` is stamped under the row lock**, before the invitation is
 * written: a conditional update that re-checks every refusal and that
 * `invitedAt` is still what was read. Postgres re-evaluates the condition on
 * the locked row, so a removal, an erasure or a second admin's invite landing
 * between the read and the write makes it match nothing, and this invite is
 * refused rather than sent beside "Removed" or sent twice. A failure to issue
 * the invitation puts the previous `invitedAt` back.
 *
 * Everything here runs in the admin's org (`runAsOrg`, entered by the guard).
 *
 * @see .context/waitlist/overview.md — Invites
 */

import { randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import type { Logger } from '@/lib/logging';
import { logger } from '@/lib/logging';
import { deliverInvitation, type DeliveredInvitation } from '@/lib/auth/invitation-delivery';
import { DEFAULT_USER_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { requireOrgId } from '@/lib/tenancy/context';
import { getValidInvitation, type InvitationMetadata } from '@/lib/utils/invitation-token';
import type { ResolvedWaitlistConfig } from '@/lib/waitlist/config';
import { WAITLIST_ENTRY_SELECT, type AdminWaitlistEntry } from '@/lib/waitlist/admin';
import { firstNameOf } from '@/lib/waitlist/mail';
import type { WaitlistInviteWaveInput } from '@/lib/validations/waitlist';

/** Why an entry was not invited. Each is a 409 on the single route, a row outcome on a wave. */
export type WaitlistInviteRefusal =
  | 'not_found'
  | 'removed'
  | 'joined'
  | 'unconfirmed'
  | 'flagged'
  | 'account_exists'
  | 'invitation_pending'
  /** The entry changed between the read and the stamp — removed, erased, or invited by someone else. */
  | 'changed';

export type WaitlistInviteResult =
  | {
      outcome: 'invited' | 'resent';
      entry: AdminWaitlistEntry;
      emailStatus: DeliveredInvitation['emailStatus'];
      expiresAt: Date;
    }
  | { outcome: 'refused'; reason: WaitlistInviteRefusal };

export interface WaitlistInviter {
  id: string;
  name: string | null;
}

/** The entries an invite may be sent to, as a `where`: the refusals that are the entry's own state. */
const INVITABLE: Prisma.WaitlistEntryWhereInput = {
  removedAt: null,
  joinedAt: null,
  userId: null,
  confirmedAt: { not: null },
  flaggedReason: null,
};

/** The refusal an entry's own state calls for, or null when it may be invited. */
function stateRefusal(entry: {
  removedAt: Date | null;
  joinedAt: Date | null;
  userId: string | null;
  confirmedAt: Date | null;
  flaggedReason: string | null;
}): WaitlistInviteRefusal | null {
  if (entry.removedAt) return 'removed';
  if (entry.joinedAt || entry.userId) return 'joined';
  if (!entry.confirmedAt) return 'unconfirmed';
  if (entry.flaggedReason) return 'flagged';
  return null;
}

/**
 * The name the account is created with: the name they gave, else the part of
 * the address before the `@`. Never empty — sign-up needs one — and the person
 * can change it once they are in.
 */
function accountName(entry: { name: string | null; email: string }): string {
  return entry.name?.trim() || entry.email.split('@')[0] || entry.email;
}

/**
 * Invite one entry in the current org. Never throws for a refusal; a failure
 * to issue the invitation (the database, not the email) throws, after putting
 * `invitedAt` back. A failed email does not fail the invite: the invitation
 * exists, `emailStatus` says the email did not go, and Resend sends another.
 */
export async function inviteWaitlistEntry(input: {
  entryId: string;
  inviter: WaitlistInviter;
  log: Logger;
  now?: Date;
}): Promise<WaitlistInviteResult> {
  const { entryId, inviter, log } = input;
  const now = input.now ?? new Date();
  const orgId = requireOrgId();

  const row = await prisma.waitlistEntry.findUnique({
    where: { id: entryId },
    select: { ...WAITLIST_ENTRY_SELECT, userId: true },
  });
  if (!row) return { outcome: 'refused', reason: 'not_found' };
  const refusal = stateRefusal(row);
  if (refusal) return { outcome: 'refused', reason: refusal };

  // Someone let in another way — Admin → Users → Invite, or a public sign-up
  // before the list was gated — has an account the entry does not know about.
  const account = await prisma.user.findUnique({
    where: { email: row.email },
    select: { id: true },
  });
  if (account) return { outcome: 'refused', reason: 'account_exists' };

  const pending = await getValidInvitation(row.email);
  if (pending && pending.metadata.waitlistEntryId !== row.id) {
    return { outcome: 'refused', reason: 'invitation_pending' };
  }
  const isResend = pending !== null;

  // The stamp is the lock: every refusal again, and `invitedAt` as read, so
  // only one of two concurrent invites of this entry gets past here.
  const stamped = await prisma.waitlistEntry.updateMany({
    where: { id: row.id, invitedAt: row.invitedAt, ...INVITABLE },
    data: { invitedAt: now },
  });
  if (stamped.count === 0) return { outcome: 'refused', reason: 'changed' };

  const metadata: InvitationMetadata = {
    name: accountName(row),
    role: DEFAULT_USER_ROLE,
    invitedBy: inviter.id,
    invitedAt: now.toISOString(),
    // As the platform route writes it: an invitation into the install org
    // names none.
    ...(orgId !== INSTALL_ORG_ID ? { orgId } : {}),
    waitlistEntryId: row.id,
  };

  let delivered: DeliveredInvitation;
  try {
    delivered = await deliverInvitation({
      email: row.email,
      // The email greets them only by something that looks like a first name
      // (the waitlist's rule, `firstNameOf()`): a URL typed as a name must not
      // arrive as a link from the real sender.
      name: firstNameOf(row.name) ?? 'there',
      metadata,
      isResend,
      inviterName: inviter.name || 'The team',
      log,
    });
  } catch (error) {
    // No invitation was written (or the old one is gone and no new one
    // stands): the entry must not say it was invited. Only if nothing has
    // stamped it since.
    await prisma.waitlistEntry
      .updateMany({ where: { id: row.id, invitedAt: now }, data: { invitedAt: row.invitedAt } })
      .catch((restoreError: unknown) => {
        logger.error('Waitlist invite: could not put invitedAt back', restoreError, {
          entryId: row.id,
        });
      });
    throw error;
  }

  return {
    outcome: isResend ? 'resent' : 'invited',
    entry: { ...pick(row), invitedAt: now },
    emailStatus: delivered.emailStatus,
    expiresAt: delivered.expiresAt,
  };
}

/** The admin's view of the row, without the `userId` read for the refusal. */
function pick(row: AdminWaitlistEntry & { userId: string | null }): AdminWaitlistEntry {
  const { userId: _userId, ...entry } = row;
  return entry;
}

// ── Invite waves (decision 7) ───────────────────────────────────────────────

/** One row of a wave's answer: the entry and what happened to it. */
export interface WaitlistWaveRowResult {
  id: string;
  outcome: 'invited' | 'resent' | 'refused' | 'failed';
  reason?: WaitlistInviteRefusal;
  emailStatus?: DeliveredInvitation['emailStatus'];
}

export interface WaitlistWaveResult {
  /** How many entries the wave chose. */
  selected: number;
  invited: number;
  refused: number;
  failed: number;
  /** Invitations that exist but whose email did not go. */
  emailNotSent: number;
  rows: WaitlistWaveRowResult[];
}

/**
 * The entries a wave is for, in the current org.
 *
 * - `ids`: the rows the admin ticked, as given. Each is checked when it is
 *   invited, so a ticked row that cannot be invited is a refused row.
 * - `next`: the first `count` by join date, oldest first, among entries that
 *   can be invited and have not been — optionally on one list, optionally
 *   with one answer to a declared field.
 * - `sample`: `count` chosen at random from the same set.
 *
 * A field the config no longer declares, or a list it does not, selects nothing.
 */
export async function selectWaveEntries(
  config: ResolvedWaitlistConfig,
  input: WaitlistInviteWaveInput
): Promise<string[]> {
  if (input.mode === 'ids') return [...new Set(input.ids)];

  const declared = config.lists.map((l) => l.key);
  const lists = input.list !== undefined ? declared.filter((k) => k === input.list) : declared;
  const and: Prisma.WaitlistEntryWhereInput[] = [
    INVITABLE,
    { invitedAt: null, list: { in: lists } },
  ];
  if (input.answer) {
    const field = config.fields.find((f) => f.key === input.answer?.field);
    if (!field) return [];
    and.push({ details: { path: [field.key], equals: input.answer.value } });
  }
  const where: Prisma.WaitlistEntryWhereInput = { AND: and };

  if (input.mode === 'next') {
    const rows = await prisma.waitlistEntry.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.count,
    });
    return rows.map((r) => r.id);
  }

  // A random sample, drawn here rather than by `ORDER BY random()`: ids only,
  // and a partial Fisher–Yates over them with a CSPRNG.
  const ids = (await prisma.waitlistEntry.findMany({ where, select: { id: true } })).map(
    (r) => r.id
  );
  const take = Math.min(input.count, ids.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + randomInt(ids.length - i);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, take);
}

/**
 * Invite each chosen entry in turn and report every row. One entry failing —
 * refused, or its invitation could not be written — never stops the others.
 */
export async function inviteWaitlistWave(input: {
  ids: readonly string[];
  inviter: WaitlistInviter;
  log: Logger;
}): Promise<WaitlistWaveResult> {
  const rows: WaitlistWaveRowResult[] = [];
  for (const id of input.ids) {
    try {
      const result = await inviteWaitlistEntry({
        entryId: id,
        inviter: input.inviter,
        log: input.log,
      });
      rows.push(
        result.outcome === 'refused'
          ? { id, outcome: 'refused', reason: result.reason }
          : { id, outcome: result.outcome, emailStatus: result.emailStatus }
      );
    } catch (error) {
      input.log.error('Waitlist wave: an invitation could not be issued', error, { entryId: id });
      rows.push({ id, outcome: 'failed' });
    }
  }
  const count = (o: WaitlistWaveRowResult['outcome'][]) =>
    rows.filter((r) => o.includes(r.outcome)).length;
  return {
    selected: input.ids.length,
    invited: count(['invited', 'resent']),
    refused: count(['refused']),
    failed: count(['failed']),
    emailNotSent: rows.filter((r) => r.emailStatus !== undefined && r.emailStatus !== 'sent')
      .length,
    rows,
  };
}
