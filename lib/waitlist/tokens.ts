/**
 * The two links in a waitlist email (§125 t-977): confirm, and leave.
 *
 * **Confirm is stored, single use, and expires.** It follows the invitation
 * token (`lib/utils/invitation-token.ts`): 32 random bytes, only their SHA-256
 * hash kept in `Verification`, seven days, deleted when used. The identifier is
 * `waitlist-confirm:<entryId>`, not the address, so the Verification table does
 * not become another place holding a stranger's email.
 *
 * **Every link sent stays good until it expires or the entry is confirmed.**
 * A re-send adds a token rather than replacing one, so a failed send cannot
 * kill the link already in the inbox, and nobody who resubmits the address
 * can kill the owner's link either. Confirming deletes them all. There are at
 * most a week of hourly sends' worth per entry (the mail cap), and an issue
 * clears the entry's expired ones.
 *
 * **Leave is signed, not stored.** HMAC-SHA256 over `{ typ, entryId }` with
 * `BETTER_AUTH_SECRET`, the construction `lib/orchestration/approval-tokens.ts`
 * uses. It has no expiry: it works for as long as the entry exists, because
 * nothing should stop someone leaving the list. Entry ids are cuids, so a link
 * for an erased entry can never name a later one.
 *
 * `typ` is inside the signed bytes and asserted on verify. Without it a token
 * from another scheme signed with the same secret (approval, storage) could
 * verify here if the payload shapes ever overlapped.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';

const CONFIRM_TOKEN_BYTES = 32;
/** Seven days, as an invitation. */
export const WAITLIST_CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Prefix of a `Verification.identifier` holding a waitlist confirmation. */
export const WAITLIST_CONFIRM_IDENTIFIER_PREFIX = 'waitlist-confirm:';

const LEAVE_TOKEN_TYPE = 'waitlist-leave';

/** The `Verification.identifier` for one entry's confirmation token. */
export function confirmIdentifier(entryId: string): string {
  return `${WAITLIST_CONFIRM_IDENTIFIER_PREFIX}${entryId}`;
}

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a confirmation token for the entry, beside any it already has, and
 * clear its expired ones. Returns the raw token (it goes in the email and
 * nowhere else), its row id (to withdraw it if the email is never sent), and
 * when it expires.
 */
export async function issueConfirmToken(
  entryId: string,
  now: Date = new Date()
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomBytes(CONFIRM_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(now.getTime() + WAITLIST_CONFIRM_TTL_MS);
  const identifier = confirmIdentifier(entryId);
  const row = await prisma.$transaction(async (tx) => {
    await tx.verification.deleteMany({ where: { identifier, expiresAt: { lte: now } } });
    return tx.verification.create({
      data: { identifier, value: sha256(token), expiresAt },
      select: { id: true },
    });
  });
  return { id: row.id, token, expiresAt };
}

/**
 * The stored token row this raw token matches, if it is current. Reads only:
 * `confirmWaitlistEntry()` deletes the row in the transaction that confirms,
 * once it knows the entry can be. A wrong, expired or used token are all
 * `null`. Every live row is compared, in constant time each.
 */
export async function findConfirmToken(
  entryId: string,
  token: string,
  now: Date = new Date()
): Promise<{ id: string; value: string } | null> {
  const rows = await prisma.verification.findMany({
    where: { identifier: confirmIdentifier(entryId), expiresAt: { gt: now } },
    select: { id: true, value: true },
  });
  const given = Buffer.from(sha256(token), 'utf8');
  let match: { id: string; value: string } | null = null;
  for (const row of rows) {
    const stored = Buffer.from(row.value, 'utf8');
    if (stored.length === given.length && timingSafeEqual(stored, given)) match = row;
  }
  return match;
}

/** Most identifiers one token delete names. */
const TOKEN_DELETE_CHUNK = 1000;

/**
 * Delete the confirmation tokens of entries that are being deleted, in the
 * caller's transaction. Every path that deletes an entry calls it: the leave
 * link and admin erase, retention, account erasure and org erasure. A token
 * left behind names an entry that is gone; the link would only ever fail, but
 * it is the entry's, and it should go with it.
 */
export async function deleteConfirmTokens(
  tx: Prisma.TransactionClient,
  entryIds: readonly string[]
): Promise<void> {
  for (let i = 0; i < entryIds.length; i += TOKEN_DELETE_CHUNK) {
    const chunk = entryIds.slice(i, i + TOKEN_DELETE_CHUNK);
    await tx.verification.deleteMany({
      where: { identifier: { in: chunk.map(confirmIdentifier) } },
    });
  }
}

const leavePayloadSchema = z.object({
  typ: z.literal(LEAVE_TOKEN_TYPE),
  entryId: z.string().min(1).max(100),
});

function hmac(payloadJson: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET)
    .update(payloadJson, 'utf8')
    .digest('base64url');
}

/** Sign a leave link for the entry. */
export function signLeaveToken(entryId: string): string {
  const payloadJson = JSON.stringify({ typ: LEAVE_TOKEN_TYPE, entryId });
  return `${Buffer.from(payloadJson, 'utf8').toString('base64url')}.${hmac(payloadJson)}`;
}

/** The entry a leave token names, or `null` when it is not one of ours. */
export function verifyLeaveToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadJson = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(hmac(payloadJson), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const parsed = leavePayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data.entryId : null;
}

/** The links a waitlist email carries, on the app's own origin. */
export function confirmUrl(entryId: string, token: string): string {
  const url = new URL('/waitlist/confirm', env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set('entry', entryId);
  url.searchParams.set('token', token);
  return url.toString();
}

export function leaveUrl(entryId: string): string {
  const url = new URL('/waitlist/leave', env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set('token', signLeaveToken(entryId));
  return url.toString();
}
