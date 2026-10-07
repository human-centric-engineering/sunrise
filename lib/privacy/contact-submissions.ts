/**
 * The one way to find a data subject's contact-form messages.
 *
 * `ContactSubmission` has no FK to `User` and no user id in any column: the
 * public contact form takes an address, not a session. The address is the only
 * link, so subject access (`export-sources.ts`) and erasure (`erase-user.ts`)
 * both match on it — through this function, so the two cannot drift apart.
 */

/** The account fields the match depends on, read from the `User` row. */
export interface ContactSubject {
  email: string;
  /** Whether the account has proven it owns `email`. */
  emailVerified: boolean;
}

/**
 * The `where` that selects the subject's contact submissions, or `null` when
 * there are none we can attribute to them.
 *
 * A contact message carries whatever address its sender typed — the form
 * proves nothing. So a message is the subject's only when their account has
 * PROVEN that address: with email verification off, anyone can open an account
 * under someone else's address, and matching it would hand that person a
 * stranger's enquiries in an export and delete them on erasure. An unverified
 * account therefore matches nothing; an operator answers that request by hand.
 *
 * ⚠️ Matches EXACTLY on the address normalised the way the writer normalises
 * it — never `mode: 'insensitive'`. Prisma compiles that to an unescaped
 * `ILIKE`, so `_` and `%` in an address match other people's rows: on export
 * that hands the subject a stranger's message, and on erasure it deletes one
 * (#766). The contact route is the only writer and stores `emailSchema` output
 * (trimmed, lower-cased), so the same normalisation finds every row of the
 * subject's.
 */
export function contactSubmissionsOf(subject: ContactSubject): { email: string } | null {
  if (!subject.emailVerified) return null;
  return { email: subject.email.trim().toLowerCase() };
}
