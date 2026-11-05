/**
 * Email-change token discrimination (#489).
 *
 * better-auth routes an email CHANGE through the same two callbacks as a normal
 * signup verification — `emailVerification.sendVerificationEmail` and
 * `emailVerification.afterEmailVerification` — and neither callback's arguments
 * carry a flag saying which flow it is. Worse, during a change the `user.email`
 * handed to `sendVerificationEmail` is already the NEW address while the DB row
 * still holds the old one, so the obvious "compare against the DB" test is
 * misleading rather than merely absent.
 *
 * The reliable discriminator is the token. better-auth mints it as an HS256 JWT
 * and the payload shape differs by flow:
 *
 *   signup / resend  →  { email, userId }
 *   email change     →  { email: <OLD>, updateTo: <NEW>, requestType: 'change-email-…', userId }
 *
 * So `updateTo` both identifies the flow and hands back the previous address —
 * which is exactly what the old-address notification and the session revocation
 * need, and what neither callback otherwise provides.
 *
 * This matters because both shared hooks do something that is wrong for a
 * change: `sendVerificationEmailHook` skips sending when the target address has
 * a pending invitation (correct for signup, but it would strand a change), and
 * `afterEmailVerificationHook` sends the welcome email (correct for signup,
 * absurd for an established user who just moved address).
 *
 * @see lib/auth/config.ts · .context/auth/security.md
 */
import { z } from 'zod';
import { verifyJWT } from 'better-auth/crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';

/**
 * The claims better-auth puts in a verification token. Only `email` is always
 * present; `updateTo` appears exclusively on email-change tokens.
 *
 * Validated with Zod rather than cast: this is a decoded JWT payload, i.e.
 * external data by the project's type-safety rule, even though we minted it.
 */
const emailChangeClaimsSchema = z.object({
  /** The address the account is moving FROM. */
  email: z.string(),
  /** The address the account is moving TO. Absent on signup tokens. */
  updateTo: z.string().optional(),
  requestType: z.string().optional(),
});

/** A verification token that belongs to an email-change flow. */
export interface EmailChangeToken {
  /** The address the account is moving away from. */
  previousEmail: string;
  /** The address the account is moving to. */
  newEmail: string;
}

/**
 * Return the change details if `token` is an email-change verification token,
 * or `null` if it is an ordinary signup/resend verification.
 *
 * Signature-verifies rather than bare-decoding. better-auth minted this token
 * in-process and already verified it before invoking the callbacks, so this is
 * belt-and-braces — but the result gates whether we skip the welcome email and
 * whether we revoke sessions, and a helper that silently trusted an unverified
 * payload would be a trap for the next caller who reaches for it in a context
 * where the token is genuinely untrusted.
 *
 * Never throws: a malformed or unverifiable token resolves to `null`, which
 * routes the caller down the ordinary signup path. That is the safe default —
 * treating a real change as a signup sends a redundant welcome email, whereas
 * treating a signup as a change would skip one and revoke sessions for no
 * reason.
 */
export async function parseEmailChangeToken(
  token: string | undefined
): Promise<EmailChangeToken | null> {
  if (!token) return null;

  let claims: unknown;
  try {
    claims = await verifyJWT(token, env.BETTER_AUTH_SECRET);
  } catch (error) {
    logger.warn('Could not verify email verification token; treating as signup verification', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const parsed = emailChangeClaimsSchema.safeParse(claims);
  if (!parsed.success) return null;

  const { email, updateTo, requestType } = parsed.data;
  // Check both, not just `updateTo`: `requestType` is the discriminator
  // better-auth's own verify-email handler switches on internally, across more
  // branches than the two this codebase currently reaches through this
  // callback pair. Gating on `updateTo` alone would misclassify any future
  // token shape that carries `updateTo` under a `requestType` this function
  // doesn't yet know about, as a plain email change — the safer failure here
  // is to require the exact request type we've verified this hook receives.
  if (!updateTo || requestType !== 'change-email-verification') return null;

  return { previousEmail: email, newEmail: updateTo };
}

/**
 * Pull the `token` query parameter out of a better-auth verification request.
 *
 * `afterEmailVerification` receives the Request rather than the token, so this
 * is how that hook reaches the discriminator. `request` is optional in
 * better-auth's type (it is absent when `auth.api.*` is driven server-side
 * without one), hence the tolerant signature.
 */
export function getVerificationTokenFromRequest(request: Request | undefined): string | undefined {
  if (!request) return undefined;
  try {
    return new URL(request.url).searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}
