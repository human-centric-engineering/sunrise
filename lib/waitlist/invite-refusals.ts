/**
 * What each invite refusal says (§125 t-978) — the single route's 409 message
 * and the page's per-row line. Client-safe: no server imports.
 */

import type { WaitlistInviteRefusal } from '@/lib/waitlist/invite';

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
