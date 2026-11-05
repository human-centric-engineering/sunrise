/**
 * The emails a waitlist join sends (§125 t-977).
 *
 * A join that wrote or replaced an unconfirmed entry sends the confirmation
 * link; a repeat of a confirmed address sends the "already on the list" note
 * instead, with no link. A removed address, a flagged entry, a honeypot hit
 * and a closed list send nothing: an entry the config's `screen()` held back as
 * suspected abuse must not be able to use our sender on a stranger either.
 *
 * **At most one an hour per entry**, both kinds together, claimed by a
 * conditional write on `lastEmailedAt` so two concurrent joins cannot both
 * send. Without it the form would put up to the IP limit's worth of mail from
 * our sender into any inbox someone types. A send that did not go out — it
 * failed, or email is not configured — gives the slot back and withdraws the
 * link it minted, so the next join can try again and the links already in the
 * inbox are untouched.
 *
 * **The "already on the list" note waits {@link WAITLIST_NOTE_INTERVAL_MS}
 * since the entry's last email.** It tells the owner nothing they need soon,
 * and an hourly allowance would let anyone who types a confirmed address mail
 * its owner every hour for good.
 *
 * **At most {@link WAITLIST_CONFIRM_MAX_LINKS} confirmation links per entry,
 * ever.** Each one moves the entry's retention window (`confirmWindowFrom`),
 * so without a cap a stranger resubmitting an address nobody confirms could
 * mail it every hour and keep it on the list for good. Past the cap the entry
 * gets nothing more and is deleted when its window runs out; its owner can
 * join afresh after that.
 *
 * **Sent after the response** (the route hands `after()` a function that
 * starts it, not a running promise), so neither the send nor the decision
 * whether to send can be timed from outside — the response for a member and a
 * non-member is the same, and so is its timing.
 *
 * **No address in the logs.** The entry id and the outcome only. (`sendEmail`
 * logs its recipient under a PII key, which production redacts.)
 */

import type * as React from 'react';
import { prisma } from '@/lib/db/client';
import { resolveEmailTemplate } from '@/lib/email/registry';
import { sendEmail } from '@/lib/email/send';
import { BRAND } from '@/lib/brand';
import { logger } from '@/lib/logging';
import type { WaitlistJoinOutcome } from '@/lib/waitlist/join';
import { confirmUrl, issueConfirmToken, leaveUrl } from '@/lib/waitlist/tokens';

/** The shortest gap between two waitlist emails to one entry. */
export const WAITLIST_MAIL_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The shortest gap before the "already on the list" note, since the entry's
 * last email of either kind.
 */
export const WAITLIST_NOTE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** The most confirmation links one entry is ever sent. */
export const WAITLIST_CONFIRM_MAX_LINKS = 3;

/**
 * What a first name may look like to be put in an email: a letter, then up to
 * 39 letters (any script, with combining marks), apostrophes or hyphens.
 * Deliberately narrow — the name is free text from an anonymous form going to
 * an unverified inbox, and a mail client links anything that looks like a URL,
 * whatever React escapes. Anything else gets the impersonal greeting.
 */
const FIRST_NAME = /^\p{L}[\p{L}\p{M}'’-]{0,39}$/u;

/** The first word of `name` if it looks like a first name, else `null`. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first && FIRST_NAME.test(first) ? first : null;
}

/** Which email a join outcome calls for, if any. */
export function mailForOutcome(
  outcome: WaitlistJoinOutcome
): 'waitlistConfirm' | 'waitlistAlreadyOnList' | null {
  switch (outcome) {
    case 'created':
    case 'replaced':
      return 'waitlistConfirm';
    case 'filled':
    case 'unchanged':
      return 'waitlistAlreadyOnList';
    case 'rejoin-counted':
      return null;
  }
}

/**
 * A claimed slot: what the claim changed, to put back if the send fails. A
 * confirmation link's claim (`link`) also moved the retention window and the
 * link count; the note's moved only `lastEmailedAt`.
 */
type MailSlot =
  | { link: true; previous: Date | null; previousWindowFrom: Date }
  | { link: false; previous: Date | null };

/** Why no slot was claimed. */
type NoSlot = 'gone' | 'flagged' | 'recent' | 'link-limit';

/**
 * Take this hour's email for the entry. The slot when the caller may send,
 * else why not: the entry is gone or removed, `screen()` flagged it, one went
 * out too recently (the hour, or the note's longer wait), or it has had all
 * its confirmation links. The write
 * is conditional on the values read, so of two concurrent joins only one gets
 * the slot.
 */
async function claimMailSlot(
  entryId: string,
  kind: 'waitlistConfirm' | 'waitlistAlreadyOnList',
  now: Date
): Promise<MailSlot | NoSlot> {
  const entry = await prisma.waitlistEntry.findUnique({
    where: { id: entryId },
    select: {
      lastEmailedAt: true,
      removedAt: true,
      flaggedReason: true,
      confirmWindowFrom: true,
      confirmLinksSent: true,
    },
  });
  if (!entry || entry.removedAt) return 'gone';
  if (entry.flaggedReason) return 'flagged';
  const previous = entry.lastEmailedAt ?? null;
  const link = kind === 'waitlistConfirm';
  const interval = link ? WAITLIST_MAIL_INTERVAL_MS : WAITLIST_NOTE_INTERVAL_MS;
  if (previous && previous.getTime() > now.getTime() - interval) return 'recent';
  if (link && entry.confirmLinksSent >= WAITLIST_CONFIRM_MAX_LINKS) return 'link-limit';
  const { count } = await prisma.waitlistEntry.updateMany({
    where: {
      id: entryId,
      removedAt: null,
      flaggedReason: null,
      lastEmailedAt: previous,
      ...(link ? { confirmLinksSent: entry.confirmLinksSent } : {}),
    },
    data: link
      ? { lastEmailedAt: now, confirmWindowFrom: now, confirmLinksSent: { increment: 1 } }
      : { lastEmailedAt: now },
  });
  if (count !== 1) return 'recent';
  return link
    ? { link: true, previous, previousWindowFrom: entry.confirmWindowFrom }
    : { link: false, previous };
}

/**
 * Undo a claim whose email never went: the slot back, so the next join can
 * send, the window and link count as they were, and the minted token
 * withdrawn, since no inbox holds it. Only if nothing has claimed since.
 * Never throws; a failure here leaves the slot taken for the hour, which is
 * the safe side.
 */
async function releaseMailSlot(
  entryId: string,
  slot: MailSlot,
  now: Date,
  tokenId: string | null
): Promise<void> {
  try {
    await prisma.waitlistEntry.updateMany({
      where: { id: entryId, lastEmailedAt: now },
      data: slot.link
        ? {
            lastEmailedAt: slot.previous,
            confirmWindowFrom: slot.previousWindowFrom,
            confirmLinksSent: { decrement: 1 },
          }
        : { lastEmailedAt: slot.previous },
    });
    if (tokenId) await prisma.waitlistConfirmToken.deleteMany({ where: { id: tokenId } });
  } catch (error) {
    logger.error('Waitlist email slot not released', error, { entryId });
  }
}

/** The log line for each reason a join sends nothing. */
const NO_SLOT_LOG: Record<NoSlot, string> = {
  gone: 'Waitlist email skipped: the entry is gone or removed',
  flagged: 'Waitlist email skipped: the entry is flagged',
  recent: 'Waitlist email skipped: one was sent too recently',
  'link-limit': 'Waitlist email skipped: the entry has had all its confirmation links',
};

export type WaitlistMailResult = 'sent' | 'not-sent' | 'capped' | 'held' | 'none';

/**
 * Send the email `outcome` calls for to the entry, if this hour's slot is
 * free. Call inside the entry's org. Never throws: the join has already been
 * answered, and a failed send is logged rather than surfaced.
 */
export async function sendWaitlistJoinMail(
  entryId: string,
  outcome: WaitlistJoinOutcome,
  now: Date = new Date()
): Promise<WaitlistMailResult> {
  const kind = mailForOutcome(outcome);
  if (!kind) return 'none';
  let slot: MailSlot | null = null;
  let tokenId: string | null = null;
  try {
    const claim = await claimMailSlot(entryId, kind, now);
    if (typeof claim === 'string') {
      logger.info(NO_SLOT_LOG[claim], { entryId, kind });
      if (claim === 'gone') return 'none';
      return claim === 'flagged' ? 'held' : 'capped';
    }
    slot = claim;
    const entry = await prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: { email: true, name: true },
    });
    if (!entry) return 'none';

    const firstName = firstNameOf(entry.name);
    const leave = leaveUrl(entryId);
    let subject: string;
    let react: React.ReactElement;
    if (kind === 'waitlistConfirm') {
      const issued = await issueConfirmToken(entryId, now);
      tokenId = issued.id;
      const { token, expiresAt } = issued;
      subject = `Confirm your place on the ${BRAND.name} waitlist`;
      react = resolveEmailTemplate('waitlistConfirm', {
        firstName,
        confirmUrl: confirmUrl(entryId, token),
        leaveUrl: leave,
        expiresAt,
      });
    } else {
      subject = `You're already on the ${BRAND.name} waitlist`;
      react = resolveEmailTemplate('waitlistAlreadyOnList', { firstName, leaveUrl: leave });
    }

    const result = await sendEmail({ to: entry.email, subject, react });
    // Only a real send keeps the claim: `disabled` (email not configured, in
    // development and test) reports success but put nothing in an inbox.
    if (result.success && result.status === 'sent') {
      logger.info('Waitlist email sent', { entryId, kind, status: result.status });
      return 'sent';
    }
    logger.warn('Waitlist email not sent', {
      entryId,
      kind,
      status: result.status,
      error: result.error,
    });
    await releaseMailSlot(entryId, slot, now, tokenId);
    return 'not-sent';
  } catch (error) {
    logger.error('Waitlist email failed', error, { entryId, kind });
    if (slot) await releaseMailSlot(entryId, slot, now, tokenId);
    return 'not-sent';
  }
}
