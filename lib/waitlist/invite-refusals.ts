/**
 * Why an entry is not invited, and what each reason says (§125 t-978) — the
 * single route's 409 message, a wave's refused row, and the page's per-row
 * line. Client-safe: no server imports, so the admin page reads the same list
 * and the same rule the server applies.
 */

/** Every refusal, once: the type, the messages and the page's schema all derive from this. */
export const WAITLIST_INVITE_REFUSALS = [
  'not_found',
  'removed',
  'joined',
  'unconfirmed',
  'flagged',
  'account_exists',
  'invitation_pending',
  /** The entry changed between the read and the stamp — removed, erased, or invited by someone else. */
  'changed',
] as const;

/** Why an entry was not invited. Each is a 409 on the single route, a row outcome on a wave. */
export type WaitlistInviteRefusal = (typeof WAITLIST_INVITE_REFUSALS)[number];

export const WAITLIST_INVITE_REFUSAL_MESSAGES: Record<WaitlistInviteRefusal, string> = {
  not_found: 'This entry is no longer on the waitlist.',
  removed: 'This person was taken off the list. Restore them before inviting them.',
  joined: 'This person has already signed up.',
  unconfirmed: 'This person has not confirmed their address yet, so they cannot be invited.',
  flagged: 'This entry is flagged for review. Look at it before inviting them.',
  account_exists: 'This address already has an account.',
  invitation_pending:
    'Someone else has already invited this address, and that invitation has not been used yet.',
  changed: 'This entry changed while you were inviting them. Reload and try again.',
};

/**
 * The refusal an entry's own state calls for, or null when it may be invited.
 * Takes dates or their JSON strings, so the server's row and the page's row
 * are judged by the same rule. `userId` is optional: the page does not see it,
 * and an entry with one also has `joinedAt`.
 */
export function entryStateRefusal(entry: {
  removedAt: Date | string | null;
  joinedAt: Date | string | null;
  userId?: string | null;
  confirmedAt: Date | string | null;
  flaggedReason: string | null;
}): WaitlistInviteRefusal | null {
  if (entry.removedAt) return 'removed';
  if (entry.joinedAt || entry.userId) return 'joined';
  if (!entry.confirmedAt) return 'unconfirmed';
  if (entry.flaggedReason) return 'flagged';
  return null;
}
