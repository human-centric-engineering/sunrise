/**
 * Org erasure (§106 t-672) — "delete us" for a customer being offboarded,
 * the org counterpart of `eraseUser()`.
 *
 * One transaction: the pending invitations *into* the org, the `activeOrgId`
 * pointer on every session still acting in it, and the org row itself. The
 * schema does the rest — memberships and the four credential kinds cascade
 * from `Org` (`onDelete: Cascade` on each), so nothing here enumerates them,
 * and a model that joins the org later joins the cascade by declaring the
 * same policy.
 *
 * **Users are never deleted** (ruling a on the feature). The people in an
 * org are not the org's to erase: a member may belong to other orgs, and
 * their account is theirs — deleting it is `eraseUser()`, on their own
 * request or an admin's, with a receipt. So a member left with no
 * membership at all keeps their account; their sessions pointing at the
 * erased org have that pointer cleared (the guard then resolves `null` to
 * the install org at `single`, and refuses with `no-org` at `multi` until
 * they are invited somewhere), and `activeOrgForSession` gives them the
 * install-org default at their next sign-in. The alternatives — cascading
 * the users (erases accounts nobody asked to erase, and other orgs'
 * members with them), or refusing to erase an org with members (makes
 * offboarding a two-step with a manual roster purge) — were both rejected.
 *
 * **The install org is refused** (ruling b): it is the one row that always
 * exists. No receipt is written: the org is not a data subject, and the
 * memberships that go with it are exported to their subjects while they
 * exist, not after.
 *
 * Nothing here is best-effort. A throw rolls the whole erasure back — the
 * org either exists with everything, or is gone with everything.
 *
 * @see lib/tenancy/lifecycle.ts — every other org mutation, and why this one is not there
 * @see lib/privacy/export-org.ts — the export that precedes this
 * @see .context/privacy/org-erasure.md — the guide
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { INVITATION_IDENTIFIER_PREFIX } from '@/lib/utils/invitation-token';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';

export interface EraseOrgParams {
  /** Id of the org to erase. */
  orgId: string;
  /** The platform admin acting on the customer's request. */
  actorUserId: string;
}

export interface EraseOrgResult {
  erasedAt: Date;
  /** Memberships the cascade removed — how many people this org had. */
  members: number;
  /** Pending invitations into the org that were deleted with it. */
  pendingInvitations: number;
  /** Sessions that were acting in the org and had that pointer cleared. */
  sessionsCleared: number;
}

/**
 * Permanently erase an org and everything that cascades from it.
 *
 * @throws {OrgLifecycleError} `INSTALL_ORG_IMMUTABLE` for the install org,
 *   `ORG_NOT_FOUND` when no row matches — the same errors the lifecycle
 *   module throws, so the admin route maps all of them one way.
 */
export async function eraseOrg(params: EraseOrgParams): Promise<EraseOrgResult> {
  const { orgId, actorUserId } = params;

  if (orgId === INSTALL_ORG_ID) {
    throw new OrgLifecycleError(
      'INSTALL_ORG_IMMUTABLE',
      'The install organisation cannot be deleted'
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.org.findUnique({
      where: { id: orgId },
      select: { id: true, _count: { select: { memberships: true } } },
    });
    if (!org) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

    const invitations = await tx.verification.deleteMany({
      where: {
        identifier: { startsWith: INVITATION_IDENTIFIER_PREFIX },
        metadata: { path: ['orgId'], equals: orgId },
      },
    });

    // No FK from `session.activeOrgId` (better-auth owns that table's
    // shape), so the pointer is cleared by hand before the row it names goes.
    const sessions = await tx.session.updateMany({
      where: { activeOrgId: orgId },
      data: { activeOrgId: null },
    });

    // Memberships and credentials cascade.
    await tx.org.delete({ where: { id: orgId } });

    return {
      members: org._count.memberships,
      pendingInvitations: invitations.count,
      sessionsCleared: sessions.count,
    };
  });

  const erasedAt = new Date();
  logger.info('Org erased', { orgId, actorUserId, ...result });

  return { erasedAt, ...result };
}
