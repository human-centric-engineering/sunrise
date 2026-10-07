/**
 * The one way to find a data subject's contact-form messages.
 *
 * `ContactSubmission` has no FK to `User` and no user id in any column: the
 * public contact form takes an address, not a session. The address is the only
 * link, so subject access (`export-sources.ts`) and erasure (`erase-user.ts`)
 * both match on it — through this function, so the two cannot drift apart.
 */

/**
 * The `where` that selects the subject's contact submissions.
 *
 * ⚠️ Matches EXACTLY on the address normalised the way the writer normalises
 * it — never `mode: 'insensitive'`. Prisma compiles that to an unescaped
 * `ILIKE`, so `_` and `%` in an address match other people's rows: on export
 * that hands the subject a stranger's message, and on erasure it deletes one
 * (#766). The contact route is the only writer and stores `emailSchema` output
 * (trimmed, lower-cased), so the same normalisation finds every row of the
 * subject's.
 */
export function contactSubmissionsOf(email: string): { email: string } {
  return { email: email.trim().toLowerCase() };
}
