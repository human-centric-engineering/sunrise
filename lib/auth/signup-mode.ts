/**
 * Signup mode — whether accounts may be created freely or only by invitation.
 *
 * Sunrise ships a complete invitation system (hashed single-use tokens, an admin
 * invite page, `POST /api/auth/accept-invite`) whose premise is that access is
 * *granted*. This module is the switch that lets a fork actually close the other
 * door, so "invite-only" is a config line rather than a fork of a core auth file.
 *
 * `SIGNUP_MODE=open` (the default) changes nothing.
 *
 * ## What `invite_only` closes
 *
 * | Door                              | Closed by                                          |
 * | --------------------------------- | -------------------------------------------------- |
 * | `POST /api/auth/sign-up/email`    | `hooks.before` in `lib/auth/config.ts`             |
 * | Un-invited OAuth account creation | `userCreateBeforeHook` in `lib/auth/config.ts`     |
 * | The `/signup` page                | `proxy.ts` redirect to `/login`                    |
 *
 * Gating the *route* is the part that matters — `POST /api/auth/sign-up/email`
 * is reachable regardless of what the UI renders, so hiding the page alone is
 * cosmetic.
 *
 * ## Why the invited-signup context exists
 *
 * `accept-invite` creates the invited user by calling `auth.api.signUpEmail()`
 * server-side. That is NOT exempt from `hooks.before`: better-auth routes
 * `auth.api.*` through the same dispatcher as HTTP requests, so the call arrives
 * at the hook with `ctx.path === '/sign-up/email'` and would be refused by its
 * own gate — invite-only mode would break the one flow it exists to serve.
 *
 * So the exemption is explicit: `runInvitedSignup()` marks the async context,
 * and the hook consults `isInvitedSignup()`.
 *
 * It is an `AsyncLocalStorage` and not a header or a body field on purpose. A
 * header can be set by anyone who can reach the endpoint, which would turn the
 * exemption into a trivial bypass of the gate. The store is process-internal and
 * only ever set by trusted server-side code that has already validated an
 * invitation token, so it cannot be forged by a caller.
 *
 * Tenancy posture: async-local — per call stack, never shared
 * (lib/tenancy/process-state.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '@/lib/env';
import { prisma } from '@/lib/db/client';
import { humanWhere } from '@/lib/auth/account';
import { AUTH_BOOTSTRAP_ID } from '@/lib/auth/constants';
import { logger } from '@/lib/logging';
import type { InvitationMetadata } from '@/lib/validations/admin';

/**
 * What the store holds for a signup authorised by a validated invitation token.
 *
 * `invitation` is the record the token unlocked — `null` when the caller only
 * validated the token (the OAuth before hook reads its own invitation from the
 * OAuth state instead). `userCreateBeforeHook` reads it to apply the role the
 * invitation grants and to decide the org membership the signup will write.
 */
interface InvitedSignup {
  invitation: InvitationMetadata | null;
}

/**
 * Marks the async context of a signup that has already been authorised by a
 * validated invitation token.
 */
const invitedSignupContext = new AsyncLocalStorage<InvitedSignup>();

/** True when this deployment only creates accounts by invitation. */
export function isInviteOnly(): boolean {
  return env.SIGNUP_MODE === 'invite_only';
}

/**
 * Run `fn` as an invitation-authorised signup, exempting it from the
 * `invite_only` gate.
 *
 * Call this ONLY after validating an invitation token. The exemption covers the
 * whole async subtree, so keep the callback tight around the account-creation
 * call rather than wrapping a broad request handler.
 *
 * Pass the invitation the token unlocked so the user-creation hooks can apply
 * what it grants — its platform role, and (§106) the org and org role it
 * names. better-auth's database hooks run inside this same async subtree
 * (`create.after` hooks are queued and drained before the `auth.api.*` call
 * resolves), which is what makes the store readable from them.
 *
 * @example
 * const result = await runInvitedSignup(() => auth.api.signUpEmail({ body }), metadata);
 */
export function runInvitedSignup<T>(
  fn: () => Promise<T>,
  invitation: InvitationMetadata | null = null
): Promise<T> {
  return invitedSignupContext.run({ invitation }, fn);
}

/** True when running inside {@link runInvitedSignup}. */
export function isInvitedSignup(): boolean {
  return invitedSignupContext.getStore() !== undefined;
}

/**
 * The invitation the enclosing {@link runInvitedSignup} was given, or `null`
 * outside one (or when the caller passed none).
 */
export function invitedSignupInvitation(): InvitationMetadata | null {
  return invitedSignupContext.getStore()?.invitation ?? null;
}

/**
 * True when this signup is the first-human bootstrap on an empty database.
 *
 * `invite_only` would otherwise be an unrecoverable lockout on a fresh
 * deployment: `db:seed` creates only the SERVICE config-owner, which cannot log
 * in, so there would be no admin to send the first invitation and no supported
 * way to create one. Letting the very first human through — who is promoted to
 * ADMIN by the existing bootstrap in `userCreateBeforeHook` — gives the operator
 * a way in and closes permanently thereafter.
 *
 * The predicate is deliberately identical to the role bootstrap's: the
 * `AuthBootstrap` singleton is absent AND no human user exists. So the account
 * this lets through is exactly the account that would be promoted to ADMIN —
 * the gate can never admit a plain USER. It adds no exposure beyond the
 * bootstrap window that already exists in `open` mode.
 *
 * Fails CLOSED. The role bootstrap fails open because it is a convenience, but
 * this one authorises account creation, so a DB fault must refuse the signup
 * rather than admit it.
 */
export async function isFirstHumanBootstrap(): Promise<boolean> {
  try {
    const alreadyBootstrapped = await prisma.authBootstrap.findUnique({
      where: { id: AUTH_BOOTSTRAP_ID },
      select: { id: true },
    });

    if (alreadyBootstrapped) return false;

    return (await prisma.user.count({ where: humanWhere })) === 0;
  } catch (error) {
    // Fail closed — see above.
    logger.error('Signup bootstrap check failed; refusing signup in invite_only', error);
    return false;
  }
}
