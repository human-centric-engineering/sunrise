/**
 * The invitations a waitlist entry was sent (§125 t-978).
 *
 * Invitations are install-wide `Verification` rows keyed by address; one sent
 * from the waitlist also carries the entry's id
 * (`InvitationMetadata.waitlistEntryId`). These read and remove them by that
 * id, so a waitlist action never touches an invitation someone else issued
 * for the same address — from Admin → Users, or another org's list.
 *
 * Both fail closed. A database error throws rather than reading as "none",
 * and an invitation whose metadata cannot be read is counted as someone
 * else's: it is never re-sent over, and never deleted, by the waitlist.
 */

import { prisma } from '@/lib/db/client';
import { INVITATION_IDENTIFIER_PREFIX } from '@/lib/utils/invitation-token';
import { parseInvitationMetadata } from '@/lib/validations/admin';

export interface LiveInvitations {
  /** Ids of the live invitations this entry was sent. */
  ours: string[];
  /** Live invitations for the address that are not this entry's, or cannot be read. */
  others: number;
}

/** The unexpired invitations for `email`, split into this entry's and everyone else's. */
export async function liveInvitationsFor(
  email: string,
  entryId: string,
  now: Date
): Promise<LiveInvitations> {
  const rows = await prisma.verification.findMany({
    where: { identifier: `${INVITATION_IDENTIFIER_PREFIX}${email}`, expiresAt: { gt: now } },
    select: { id: true, metadata: true },
  });
  const ours: string[] = [];
  let others = 0;
  for (const row of rows) {
    if (parseInvitationMetadata(row.metadata)?.waitlistEntryId === entryId) ours.push(row.id);
    else others += 1;
  }
  return { ours, others };
}

/**
 * Delete every invitation this entry was sent, so its link stops working.
 * Returns how many went. Another invitation for the address is left.
 */
export async function revokeEntryInvitations(email: string, entryId: string): Promise<number> {
  const rows = await prisma.verification.findMany({
    where: { identifier: `${INVITATION_IDENTIFIER_PREFIX}${email}` },
    select: { id: true, metadata: true },
  });
  const ours = rows
    .filter((row) => parseInvitationMetadata(row.metadata)?.waitlistEntryId === entryId)
    .map((row) => row.id);
  if (ours.length === 0) return 0;
  const { count } = await prisma.verification.deleteMany({ where: { id: { in: ours } } });
  return count;
}
