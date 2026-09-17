/**
 * The membership a signup in flight is going to write — carried between
 * better-auth's database hooks for the duration of one auth request.
 *
 * Three hooks act on one new user and they do not run in the order the
 * names suggest. `user.create.before` decides what the user is (its platform
 * role, and — §106 — the org membership the signup grants); `user.create.after`
 * writes the membership, but better-auth queues `create.after` hooks until the
 * sign-up transaction has committed; and when the sign-up auto-signs the user
 * in (email sign-up without verification, every OAuth sign-up) the session is
 * created INSIDE that transaction, so `session.create.before` runs between the
 * two — for a user who has no membership row yet.
 *
 * Without a carrier the session hook's self-heal (a user with no membership
 * gets the install-org default) would write first, and the membership the
 * invitation actually granted would land as a no-op upsert or a second row.
 * With one, the session hook sees "a signup is in flight and will write
 * `membership`", chooses that org for the session, and writes nothing.
 *
 * The carrier is better-auth's own request state (`defineRequestState`, the
 * facility `getOAuthState` is built on): one store per auth request, shared by
 * every hook that request runs, unreadable from any other request. It is also
 * what hands an OAuth-accepted invitation's org from the before hook — which
 * consumes the invitation row — to the after hook that writes the membership.
 *
 * Outside a better-auth request (a unit test calling a hook directly, a seed)
 * there is no request state; the reader answers `null` rather than throwing,
 * and the writer is a no-op that says so.
 *
 * @see lib/auth/config.ts — the three hooks
 * @see lib/tenancy/membership.ts — what `membership` is
 */
import { defineRequestState, hasRequestState } from '@better-auth/core/context';
import { logger } from '@/lib/logging';
import type { InitialMembership } from '@/lib/tenancy/membership';

/** What the before hook records for the hooks that follow it. */
export interface PendingSignup {
  /** The membership `userCreateAfterHook` will write for this user. */
  membership: InitialMembership;
}

const pendingSignupState = defineRequestState<PendingSignup | null>(() => null);

/** Record the membership this request's signup will write. */
export async function setPendingSignup(pending: PendingSignup): Promise<void> {
  if (!(await hasRequestState())) {
    logger.warn('setPendingSignup called outside a better-auth request; nothing recorded');
    return;
  }
  await pendingSignupState.set(pending);
}

/** The signup in flight on this request, or `null`. */
export async function getPendingSignup(): Promise<PendingSignup | null> {
  if (!(await hasRequestState())) return null;
  return pendingSignupState.get();
}
