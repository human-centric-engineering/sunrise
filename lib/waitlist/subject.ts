/**
 * The one way to find a data subject's waitlist entries (§125).
 *
 * Subject access (`export-sources.ts`) and erasure (`erase-user.ts`) both match
 * through this function, so the two cannot drift apart — the
 * `contact-submissions.ts` shape.
 *
 * An entry is the subject's when it is linked to their account (`userId`, set
 * when a waitlist invitation is redeemed), or when it carries their address
 * AND their account has proven that address. The join form proves nothing
 * about who typed an address: with email verification off, anyone can open an
 * account under someone else's address, and matching it unverified would hand
 * them a stranger's answers in an export and delete the stranger's entry on
 * erasure.
 *
 * ⚠️ Matches EXACTLY on the address normalised the way the writer normalises
 * it (`emailSchema`: trimmed, lower-cased) — never `mode: 'insensitive'`,
 * whose unescaped `ILIKE` makes `_` and `%` match other people's rows (#766).
 */

import type { Prisma } from '@prisma/client';

/** The account fields the match depends on, read from the `User` row. */
export interface WaitlistSubject {
  userId: string;
  email: string;
  /** Whether the account has proven it owns `email`. */
  emailVerified: boolean;
}

/** The `where` that selects the subject's waitlist entries, in every org and list. */
export function waitlistEntriesOf(subject: WaitlistSubject): Prisma.WaitlistEntryWhereInput {
  if (!subject.emailVerified) return { userId: subject.userId };
  return { OR: [{ userId: subject.userId }, waitlistEntriesUnder(subject.email)] };
}

/**
 * Every entry under an address, whoever typed it — exact and normalised, with
 * NO verification gate. So it says nothing about whose the rows are: use it to
 * count what an erasure left behind, never to export or delete.
 */
export function waitlistEntriesUnder(email: string): { email: string } {
  return { email: email.trim().toLowerCase() };
}
