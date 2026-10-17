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
 * they are invited somewhere). At `single`, `activeOrgForSession` gives them
 * the install-org default at their next sign-in; at `multi` it does not
 * (t-836), so they stay refused until someone adds them to an org. The alternatives — cascading
 * the users (erases accounts nobody asked to erase, and other orgs'
 * members with them), or refusing to erase an org with members (makes
 * offboarding a two-step with a manual roster purge) — were both rejected.
 *
 * **The install org is refused** (ruling b): it is the one row that always
 * exists. No receipt is written: the org is not a data subject, and the
 * memberships that go with it are exported to their subjects while they
 * exist, not after.
 *
 * **The database part is all-or-nothing.** A throw inside the transaction
 * rolls the whole erasure back: the org either exists with every row, or is
 * gone with every row.
 *
 * **The storage sweep is not, and runs after the commit** (§109 t-736). The
 * org's objects live under `orgs/{orgId}/` (`lib/storage/org-keys.ts`), and an
 * object store cannot join a database transaction. Deleting first would leave
 * a rolled-back org with its files gone; deleting after leaves, at worst, an
 * erased org with files still on disk, which {@link sweepErasedOrgStorage}
 * clears (a second `eraseOrg` cannot: the org row is gone, so it refuses with
 * `ORG_NOT_FOUND` before reaching the sweep). So the sweep is best-effort, like the avatar sweep in
 * `eraseUser()`: a failure is logged and reported on the result as
 * `storageSwept: false`, never thrown, because the org is already gone and a
 * throw would tell the caller it was not.
 *
 * The sweep reaches only the prefix. Objects uploaded before org prefixes
 * existed (`agent-uploads/{agentId}/…`) name no org, so nothing can say they
 * were this org's, and they stay.
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
import { orgKeyPrefix } from '@/lib/storage/org-keys';

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
  /**
   * Whether the org's storage prefix was deleted after the commit: `true` when
   * the provider reported success, `false` when it did not or threw, `null`
   * when no storage is configured. See the module header.
   */
  storageSwept: boolean | null;
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
  const storageSwept = await sweepOrgStorage(orgId);
  logger.info('Org erased', { orgId, actorUserId, ...result, storageSwept });

  return { erasedAt, ...result, storageSwept };
}

/**
 * Re-run the storage sweep for an org that has already been erased: after
 * `eraseOrg` reported `storageSwept: false`, or when an upload in flight
 * during the erasure landed after the sweep. Call it from a one-off script
 * or console; there is deliberately no route.
 *
 * Refuses an org that still exists. Deleting a live org's files is not a
 * repair, and erasing the org is what `eraseOrg` is for.
 *
 * @returns the same verdict as `storageSwept`
 * @throws when the org has not been erased
 */
export async function sweepErasedOrgStorage(orgId: string): Promise<boolean | null> {
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { id: true } });
  if (org) {
    throw new Error(
      'This organisation still exists; erase it with eraseOrg rather than deleting its files'
    );
  }
  const storageSwept = await sweepOrgStorage(orgId);
  logger.info('Erased org storage swept again', { orgId, storageSwept });
  return storageSwept;
}

/**
 * Delete the org's storage prefix. Best-effort: runs after the transaction
 * has committed, so it reports failure instead of throwing (module header).
 */
async function sweepOrgStorage(orgId: string): Promise<boolean | null> {
  // Everything inside the try, the import and the provider lookup included:
  // provider initialisation reads configuration and can throw, and a throw here
  // would reach the caller after the org is already gone. From `client.ts`,
  // not `upload.ts`, which would also load the image pipeline for nothing.
  try {
    const { getStorageClient } = await import('@/lib/storage/client');
    // The org's own client: the unbound one refuses every key under `orgs/`.
    const storage = getStorageClient({ orgId });
    if (!storage) return null;
    const { success } = await storage.deletePrefix(orgKeyPrefix(orgId));
    return success;
  } catch (err) {
    logger.error('Org erased, but deleting its storage prefix failed', err, { orgId });
    return false;
  }
}
