/**
 * User-creation hook registry.
 *
 * Lets an app built on Sunrise react to a new account without editing
 * `lib/auth/config.ts` — provisioning a profile row, seeding a default
 * workspace, enrolling the user in an onboarding sequence, calling a CRM.
 *
 * Before this seam the only way in was to add code to `userCreateAfterHook`
 * itself, which is a security-sensitive platform file and a guaranteed merge
 * conflict on every upstream sync.
 *
 * Hooks are keyed by `name`, so re-registration under HMR or repeated module
 * imports replaces rather than duplicates.
 *
 * **Hooks must not assume they can block signup.** They run AFTER the user row
 * exists, in better-auth's `databaseHooks.user.create.after`, alongside
 * Sunrise's own non-blocking work (default preferences, invitation redemption).
 * A throw is logged and swallowed: the account has already been created, so
 * failing the request would leave the caller believing signup failed when it
 * did not. Rejecting a signup happens pre-creation, in `userCreateBeforeHook`
 * (`databaseHooks.user.create.before`) — that is where the reserved-address and
 * OAuth-invitation-mismatch refusals throw. No fork seam for it today.
 *
 * @see lib/auth/config.ts — `userCreateAfterHook`, the consumer
 * @see lib/app/user-created.ts — the fork-owned registration seam
 */

import { logger } from '@/lib/logging';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { initAppUserCreatedHooks } from '@/lib/app/user-created';

/** The newly created user, as better-auth passes it to the after-hook. */
export interface UserCreatedContext {
  /** The new user's id. */
  userId: string;
  /** The new user's email address. Not yet verified for email/password signups. */
  email: string;
  /** Display name, as supplied at signup. */
  name: string;
  /**
   * How the account was created. `oauth` when better-auth invoked the hook from
   * a provider callback, `email` otherwise. Useful because an OAuth account
   * arrives with a verified address and an email/password one does not.
   */
  signupMethod: 'oauth' | 'email';
  /**
   * True when this signup redeemed an invitation. An invited user's address is
   * already proven, so onboarding that would normally start with "verify your
   * email" should skip that step.
   */
  viaInvitation: boolean;
  /**
   * The invitation this signup redeemed, so a hook can match rows it keeps
   * against that invitation rather than against the address (#1136). `null`
   * when the signup redeemed none, and also in the rare case it redeemed a
   * token whose invitation record could not be read: `viaInvitation` is then
   * true and this is null.
   */
  invitation: RedeemedInvitation | null;
}

/**
 * Which invitation a signup redeemed. Sunrise holds at most one invitation per
 * address at a time, so the address and `invitedAt` identify it; the token
 * itself is consumed by then (on the Google path, before the account exists).
 */
export interface RedeemedInvitation {
  /** When it was sent (ISO 8601), as recorded on the invitation. */
  invitedAt: string;
  /** The id of the user who sent it. */
  invitedBy: string;
  /** The org it invited the user into: the install org when it named none. */
  orgId: string;
}

/** A unit of app-owned work that runs once, after a user row is created. */
export type UserCreatedHook = (ctx: UserCreatedContext) => Promise<void> | void;

const hooks = new Map<string, UserCreatedHook>();

/**
 * Register a user-creation hook. Idempotent by `key` — re-registering the same
 * key replaces the prior hook (safe under HMR / repeated module imports). Call
 * it inside `initAppUserCreatedHooks()` in `lib/app/user-created.ts`, not at
 * that module's top level, so a throw part-way through rolls back.
 */
export function registerUserCreatedHook(key: string, hook: UserCreatedHook): void {
  hooks.set(key, hook);
}

/**
 * Run the fork's auto-wired init exactly once, lazily, before the first
 * dispatch, rolling a partial init back — see `lib/fork-init.ts` for the shared
 * contract. A throwing init neither retries on every signup nor propagates out
 * to fail account creation.
 */
const appInit = createAppInitGate({
  label: 'user-created: initAppUserCreatedHooks',
  // Rolled back, not just logged. Signup side effects are the least reversible
  // thing a seam can do: a hook left live by a partial init provisions, emails
  // or bills every new account from a config the log says did not load.
  subject: 'app hooks',
  init: initAppUserCreatedHooks,
  snapshot: () => new Map(hooks),
  restore: (before) => restoreMap(hooks, before),
});

/**
 * Test-only: drop all registered hooks and re-arm the one-shot app init so each
 * test starts from a known state. Not exported from any barrel.
 */
export function __resetUserCreatedHooksForTests(): void {
  hooks.clear();
  appInit.reset();
}

/**
 * Run every registered hook for one new user.
 *
 * Never throws. Hooks run in parallel and are independent: one rejecting does
 * not prevent the others, and none of them can fail the signup. An empty
 * registry short-circuits — no behaviour change for vanilla Sunrise.
 */
export async function dispatchUserCreated(ctx: UserCreatedContext): Promise<void> {
  appInit.ensure();
  if (hooks.size === 0) return;

  await Promise.all(
    Array.from(hooks.entries()).map(async ([key, hook]) => {
      try {
        await hook(ctx);
      } catch (err) {
        // Swallowed deliberately: the user row already exists, so a failing app
        // hook must not turn a successful signup into an error for the caller.
        logger.error('user-created hook failed', {
          hook: key,
          userId: ctx.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}
