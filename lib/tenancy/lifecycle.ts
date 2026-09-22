/**
 * Org lifecycle — the write path for orgs and their memberships (§106 t-672).
 *
 * One module for every mutation the org API exposes, so the rules that make
 * an org administrable are stated once and every route inherits them:
 *
 * - **The install org is immutable in identity and status** (ruling b): it
 *   can be renamed, but never suspended, deleted or re-slugged — it is the one
 *   row principle 1 of the tenancy design promises always exists, and its id
 *   and slug are literals the guard, the hook and the migration name.
 * - **The install org's memberships are not this module's to shape.** Its
 *   roles follow the platform role (`initialMembershipFor`, re-applied by
 *   {@link syncInstallMembershipRole} whenever the platform role changes —
 *   ruling a on the feature), so a role change here is refused; and its
 *   membership is the account's floor at `single`, so a removal is refused
 *   too — an account leaves the install org by being erased.
 * - **An org keeps at least one OWNER.** Demoting or removing the last one is
 *   refused, the way `users/me` refuses to delete the last platform admin.
 *   Only the members API is held to this: `eraseUser` (Art. 17) is not
 *   conditional on org roles, so an org CAN be left owner-less by an
 *   erasure, and a platform admin — whom the policy admits everywhere —
 *   names a new OWNER through the same members route.
 * - **Only an OWNER confers or revokes OWNER.** The policy admits an org
 *   ADMIN to the roster, and this module is where ADMIN's "without the
 *   OWNER's standing" (`lib/tenancy/roles.ts`) is made true: an ADMIN may
 *   manage MEMBERs and other ADMINs, but may not grant `OWNER` (to anyone,
 *   themself included), change an OWNER's role, or remove an OWNER. Without
 *   this the last-OWNER guard protects the *count* of owners while letting a
 *   delegate rewrite *who* they are in two requests — promote self, remove
 *   the appointer — which is a takeover, not administration. The actor's
 *   standing is passed in ({@link MembershipActor}); a platform admin has it
 *   everywhere, which is how an owner-less org is repaired.
 * - **A removed member's sessions in that org are revoked**, the ones in
 *   their other orgs kept. The 5-minute session cookie cache is not a hole:
 *   the guard re-reads the membership on every request into a non-install
 *   org (`lib/tenancy/entry.ts`), so the removal is enforced at the next
 *   request, not at cache expiry.
 *
 * Every function takes a `db` so a smoke script can pass its own client and
 * a test can pass a double; nothing here reads the request or the tenant
 * context — the routes decide *who* may call these, the policy decides it
 * for them, and this module decides only *what* is a valid change.
 *
 * Errors are {@link OrgLifecycleError} — an `APIError` carrying a `code` and
 * the HTTP status, so every route answers them identically by letting them
 * propagate to the guard.
 *
 * @see lib/tenancy/membership.ts — the role rule, and the creation-time write path
 * @see lib/privacy/erase-org.ts — deletion, which is a privacy act rather than a lifecycle one
 * @see .context/tenancy/identity.md — the guide's lifecycle section
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { APIError } from '@/lib/api/errors';
import { revokeUserSessions } from '@/lib/auth/sessions';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { initialMembershipFor } from '@/lib/tenancy/membership';
import { orgIdParamSchema, type OrgSettingsPatch } from '@/lib/validations/tenancy';
import { applyRetentionPatch } from '@/lib/tenancy/org-settings';
import {
  DEFAULT_ORG_ROLE,
  ORG_OWNER_ROLE,
  type OrgRole,
  type OrgStatus,
} from '@/lib/tenancy/roles';

/**
 * The delegates this module touches. Includes `$transaction`, so a
 * `Prisma.TransactionClient` does NOT satisfy it — these functions open their
 * own transactions and cannot be composed inside an outer one.
 * {@link syncInstallMembershipRole} is the exception, typed on
 * `orgMembership` alone precisely so `users/[id]` can call it from inside its
 * own transaction.
 */
export type LifecycleDb = Pick<PrismaClient, 'org' | 'orgMembership' | 'user' | '$transaction'>;

/** What a lifecycle rule refuses, and how a route should say so. */
export type OrgLifecycleErrorCode =
  | 'ORG_NOT_FOUND'
  | 'USER_NOT_FOUND'
  | 'SLUG_TAKEN'
  | 'INSTALL_ORG_IMMUTABLE'
  | 'INSTALL_ORG_MEMBERSHIP'
  | 'LAST_OWNER'
  | 'ALREADY_MEMBER'
  | 'NOT_A_MEMBER'
  | 'OWNER_STANDING';

const STATUS_FOR: Record<OrgLifecycleErrorCode, number> = {
  ORG_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  SLUG_TAKEN: 409,
  INSTALL_ORG_IMMUTABLE: 400,
  INSTALL_ORG_MEMBERSHIP: 400,
  LAST_OWNER: 400,
  ALREADY_MEMBER: 409,
  NOT_A_MEMBER: 404,
  OWNER_STANDING: 403,
};

/**
 * A refused change. An `APIError`, so a route that lets it propagate gets
 * the right envelope from the guard's `handleAPIError` with no mapping of
 * its own: `status` is the HTTP answer and `code` goes in the envelope so a
 * client can branch on it without parsing the message.
 */
export class OrgLifecycleError extends APIError {
  declare readonly code: OrgLifecycleErrorCode;

  constructor(code: OrgLifecycleErrorCode, message: string) {
    super(message, code, STATUS_FOR[code]);
    this.name = 'OrgLifecycleError';
  }
}

/**
 * Who is making a membership change, as far as the ownership rule reads it:
 * a platform admin (the policy admits them to every org), or a member whose
 * role in THIS org the guard verified — `session.principal.orgRole`, which
 * the policy already required to be an administering role of the org the
 * URL names before the handler ran. The routes build it from the principal;
 * a script passes `{ platformAdmin: true }`.
 */
export interface MembershipActor {
  platformAdmin: boolean;
  orgRole?: string | null;
}

/** May this actor confer, alter or revoke the OWNER role in the org? */
function hasOwnerStanding(actor: MembershipActor): boolean {
  return actor.platformAdmin || actor.orgRole === ORG_OWNER_ROLE;
}

function requireOwnerStanding(actor: MembershipActor, what: string): void {
  if (!hasOwnerStanding(actor)) {
    throw new OrgLifecycleError('OWNER_STANDING', `Only an owner may ${what}`);
  }
}

/**
 * The org row as the lifecycle returns it.
 *
 * `settings` is the whole JSON column, the platform's `retention` slice
 * (§108 t-713) and whatever else a fork keeps beside it. Every caller of this
 * type is platform-admin-only; the member-facing org read publishes the
 * validated slice alone, not the raw column.
 */
export interface OrgRecord {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  settings: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

/** A membership row as the lifecycle returns it. */
export interface MembershipRecord {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  createdAt: Date;
  updatedAt: Date;
}

/** Isolation for the owner-count-then-write transactions (see `changeMemberRole`). */
const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

const orgSelect = {
  id: true,
  slug: true,
  name: true,
  status: true,
  settings: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrgSelect;

const membershipSelect = {
  id: true,
  orgId: true,
  userId: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrgMembershipSelect;

async function requireOrg(orgId: string, db: LifecycleDb): Promise<OrgRecord> {
  const org = await db.org.findUnique({ where: { id: orgId }, select: orgSelect });
  if (!org) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  return org;
}

/**
 * A user who can hold a membership: exists, and is not the seeded SERVICE
 * config-owner — it holds platform `ADMIN` but never signs in, and making it
 * an org OWNER would hand an org to an account nobody can act as.
 */
async function requireManageableUser(
  userId: string,
  db: LifecycleDb
): Promise<{ id: string; role: string | null; accountType: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, accountType: true },
  });
  if (!user || user.accountType === 'SERVICE') {
    throw new OrgLifecycleError('USER_NOT_FOUND', 'User not found');
  }
  return user;
}

async function requireSlugFree(slug: string, exceptOrgId: string | null, db: LifecycleDb) {
  const taken = await db.org.findUnique({ where: { slug }, select: { id: true } });
  if (taken && taken.id !== exceptOrgId) {
    throw new OrgLifecycleError('SLUG_TAKEN', 'An organisation with that slug already exists');
  }
}

/**
 * Create an org, naming its founding OWNER in the same write when one is
 * given. The pre-check on the slug gives a clean 409; a race past it
 * surfaces as Prisma's P2002, which `handleAPIError` already turns into a
 * 400 rather than a 500.
 */
export async function createOrg(
  input: { slug: string; name: string; ownerUserId?: string },
  db: LifecycleDb = prisma
): Promise<OrgRecord> {
  await requireSlugFree(input.slug, null, db);
  const owner = input.ownerUserId ? await requireManageableUser(input.ownerUserId, db) : null;

  const org = await db.$transaction(async (tx) => {
    const created = await tx.org.create({
      data: { slug: input.slug, name: input.name },
      select: orgSelect,
    });
    if (owner) {
      await tx.orgMembership.create({
        data: { orgId: created.id, userId: owner.id, role: ORG_OWNER_ROLE },
      });
    }
    return created;
  });

  logger.info('Org created', { orgId: org.id, slug: org.slug, ownerUserId: owner?.id ?? null });
  return org;
}

/**
 * Rename, re-slug, suspend or reinstate an org.
 *
 * The install org accepts a new name and nothing else: its slug is a
 * literal (`INSTALL_ORG_SLUG`) the migration and the smoke name, and its
 * status is what "one org always exists" means — a suspended install org
 * would refuse every request at `single`.
 *
 * Suspension itself writes only the status. Sessions are left standing on
 * purpose: the guard refuses entry to a suspended org on every request, and
 * the switch is the member's way to their other orgs. Reinstating is the
 * same write back, with nothing to repair.
 *
 * **A `settings` patch is a read-modify-write, so it takes a transaction**
 * (§108 t-713). `Org.settings` is one JSON column holding the platform's
 * `retention` slice beside whatever a fork keeps there, and writing it means
 * reading the current object to preserve the rest. Under the default READ
 * COMMITTED two concurrent patches would each read the object before the
 * other wrote, and the second would silently drop the first's slice — the
 * same shape, and the same answer, as the owner-count writes below. Patches
 * that do not touch `settings` are a single update, exactly as before.
 */
export async function updateOrg(
  orgId: string,
  patch: { name?: string; slug?: string; status?: OrgStatus; settings?: OrgSettingsPatch },
  db: LifecycleDb = prisma
): Promise<OrgRecord> {
  const current = await requireOrg(orgId, db);

  if (orgId === INSTALL_ORG_ID) {
    if (patch.status !== undefined && patch.status !== current.status) {
      throw new OrgLifecycleError(
        'INSTALL_ORG_IMMUTABLE',
        'The install organisation cannot be suspended'
      );
    }
    if (patch.slug !== undefined && patch.slug !== current.slug) {
      throw new OrgLifecycleError(
        'INSTALL_ORG_IMMUTABLE',
        'The install organisation’s slug cannot be changed'
      );
    }
  }

  if (patch.slug !== undefined && patch.slug !== current.slug) {
    await requireSlugFree(patch.slug, orgId, db);
  }

  const data: Prisma.OrgUpdateInput = {
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.slug !== undefined && { slug: patch.slug }),
    ...(patch.status !== undefined && { status: patch.status }),
  };

  // Keyed on `settings`, not on `settings.retention`: a patch naming another
  // slice of the column must still take the transaction, or it would report a
  // change it did not make. `orgSettingsPatchSchema` admits only `retention`
  // today, so this is the branch being right ahead of the second slice rather
  // than a reachable bug.
  const settingsPatch = patch.settings;

  const updated =
    settingsPatch === undefined
      ? await db.org.update({ where: { id: orgId }, data, select: orgSelect })
      : await db.$transaction(async (tx) => {
          // Re-read inside the transaction: `current` was read before the
          // slug check and is not the row this write is merging into.
          const row = await tx.org.findUnique({
            where: { id: orgId },
            select: { settings: true },
          });
          if (!row) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
          return tx.org.update({
            where: { id: orgId },
            data: {
              ...data,
              settings: applyRetentionPatch(row.settings, settingsPatch.retention),
            },
            select: orgSelect,
          });
        }, SERIALIZABLE);

  logger.info('Org updated', {
    orgId,
    changes: Object.keys(patch),
    ...(patch.status !== undefined && patch.status !== current.status && { status: patch.status }),
    ...(settingsPatch?.retention !== undefined && {
      retention:
        settingsPatch.retention === null || Object.keys(settingsPatch.retention).length === 0
          ? 'cleared'
          : 'set',
    }),
  });
  return updated;
}

/**
 * Add an existing user to an org.
 *
 * `role` defaults to `MEMBER`, except that the first member of an EMPTY
 * non-install org becomes its `OWNER` when no role was asked for — the
 * invitation path's bootstrap (`membershipForNewUser`), so an org created
 * without a named owner still gets one from its first member. Unlike that
 * path an explicit role is honoured: this is an API call by someone who
 * chose the role, not an invitation whose author could not know the org
 * would be empty when it was accepted.
 *
 * On the install org the role is never the caller's to pick — it follows the
 * platform role — so a body `role` is refused and the rule's answer is
 * written instead. An explicit `OWNER` needs the actor's owner standing.
 */
export async function addMember(
  orgId: string,
  userId: string,
  role: OrgRole | undefined,
  actor: MembershipActor,
  db: LifecycleDb = prisma
): Promise<MembershipRecord> {
  if (role === ORG_OWNER_ROLE) requireOwnerStanding(actor, 'add a member as an owner');
  await requireOrg(orgId, db);
  const user = await requireManageableUser(userId, db);

  const existing = await db.orgMembership.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { id: true },
  });
  if (existing) {
    throw new OrgLifecycleError('ALREADY_MEMBER', 'That user is already a member');
  }

  let effectiveRole: OrgRole;
  if (orgId === INSTALL_ORG_ID) {
    if (role !== undefined) {
      throw new OrgLifecycleError(
        'INSTALL_ORG_MEMBERSHIP',
        'Roles in the install organisation follow the platform role and cannot be set here'
      );
    }
    effectiveRole = initialMembershipFor(user).role;
  } else if (role !== undefined) {
    effectiveRole = role;
  } else {
    const members = await db.orgMembership.count({ where: { orgId } });
    effectiveRole = members === 0 ? ORG_OWNER_ROLE : DEFAULT_ORG_ROLE;
  }

  const membership = await db.orgMembership.create({
    data: { orgId, userId, role: effectiveRole },
    select: membershipSelect,
  });

  logger.info('Org member added', { orgId, userId, role: effectiveRole });
  return membership;
}

/**
 * Change a member's role. Refused on the install org (the role follows the
 * platform role); granting `OWNER`, or changing an OWNER's role, needs the
 * actor's owner standing; and demoting the org's last OWNER is refused.
 *
 * The owner count and the write run in one SERIALIZABLE transaction: under
 * the default READ COMMITTED a `count` followed by an `update` takes no lock,
 * so two concurrent demotions could each see the other OWNER still standing
 * and leave the org owner-less. At SERIALIZABLE one of them fails with a
 * serialization error instead (a 500 the caller retries), which is the
 * cheaper of the two failures — an owner-less org is repairable by a
 * platform admin, but only once someone notices.
 */
export async function changeMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole,
  actor: MembershipActor,
  db: LifecycleDb = prisma
): Promise<MembershipRecord> {
  if (orgId === INSTALL_ORG_ID) {
    throw new OrgLifecycleError(
      'INSTALL_ORG_MEMBERSHIP',
      'Roles in the install organisation follow the platform role; change the user’s platform role instead'
    );
  }
  if (role === ORG_OWNER_ROLE) requireOwnerStanding(actor, 'make a member an owner');

  const updated = await db.$transaction(async (tx) => {
    const membership = await tx.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });
    if (!membership) throw new OrgLifecycleError('NOT_A_MEMBER', 'Member not found');

    if (membership.role === ORG_OWNER_ROLE) {
      requireOwnerStanding(actor, 'change an owner’s role');
    }

    if (membership.role === ORG_OWNER_ROLE && role !== ORG_OWNER_ROLE) {
      const owners = await tx.orgMembership.count({ where: { orgId, role: ORG_OWNER_ROLE } });
      if (owners <= 1) {
        throw new OrgLifecycleError(
          'LAST_OWNER',
          'Cannot demote the last owner. Make another member an owner first.'
        );
      }
    }

    return tx.orgMembership.update({
      where: { orgId_userId: { orgId, userId } },
      data: { role },
      select: membershipSelect,
    });
  }, SERIALIZABLE);

  logger.info('Org member role changed', { orgId, userId, role });
  return updated;
}

/**
 * Remove a member. Refused on the install org; removing an OWNER needs the
 * actor's owner standing; and the org's last OWNER is refused. The user's
 * sessions acting in this org are revoked once the row is gone; their
 * sessions in other orgs are untouched. Same SERIALIZABLE transaction as
 * {@link changeMemberRole}, for the same reason.
 *
 * Returns the number of sessions revoked so the route can say so.
 */
export async function removeMember(
  orgId: string,
  userId: string,
  actor: MembershipActor,
  db: LifecycleDb = prisma
): Promise<{ revokedSessions: number }> {
  if (orgId === INSTALL_ORG_ID) {
    throw new OrgLifecycleError(
      'INSTALL_ORG_MEMBERSHIP',
      'A user cannot be removed from the install organisation; delete the account instead'
    );
  }

  await db.$transaction(async (tx) => {
    const membership = await tx.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });
    if (!membership) throw new OrgLifecycleError('NOT_A_MEMBER', 'Member not found');

    if (membership.role === ORG_OWNER_ROLE) {
      requireOwnerStanding(actor, 'remove an owner');
      const owners = await tx.orgMembership.count({ where: { orgId, role: ORG_OWNER_ROLE } });
      if (owners <= 1) {
        throw new OrgLifecycleError(
          'LAST_OWNER',
          'Cannot remove the last owner. Make another member an owner first.'
        );
      }
    }

    await tx.orgMembership.delete({ where: { orgId_userId: { orgId, userId } } });
  }, SERIALIZABLE);

  // Outside the transaction: `revokeUserSessions` is bound to the shared
  // client. A membership deleted and sessions still standing is safe — the
  // guard refuses them at the next request — where the reverse would not be.
  const revokedSessions = await revokeUserSessions({
    userId,
    activeOrgId: orgId,
    reason: 'removed from org',
  });

  logger.info('Org member removed', { orgId, userId, revokedSessions });
  return { revokedSessions };
}

/**
 * Re-apply the install-org role rule after a platform-role change (ruling a
 * on the feature: the install org's OWNER set follows the platform-admin
 * set).
 *
 * An upsert, so a user whose install membership is missing — the signup
 * hook's write failed, or a fork created the row some other way — is healed
 * by the same call rather than left for `activeOrgForSession` to notice at
 * their next sign-in. Takes the user AS UPDATED, since the rule reads the
 * role the row now carries; `users/[id]` PATCH runs it in the transaction
 * that writes the role, so the two never disagree.
 */
export async function syncInstallMembershipRole(
  user: { id: string; role: string | null; accountType: string | null },
  db: Pick<PrismaClient, 'orgMembership'> = prisma
): Promise<MembershipRecord> {
  const { role } = initialMembershipFor(user);
  const membership = await db.orgMembership.upsert({
    where: { orgId_userId: { orgId: INSTALL_ORG_ID, userId: user.id } },
    update: { role },
    create: { orgId: INSTALL_ORG_ID, userId: user.id, role },
    select: membershipSelect,
  });
  logger.info('Install-org role synced from platform role', { userId: user.id, role });
  return membership;
}

/**
 * The `resource` resolver every `/api/v1/orgs/[id]/**` route hands the
 * authorization policy: `{ kind: 'org', id, orgId: id }` for an org that
 * exists, `null` — which the guard refuses — for one that does not or for a
 * malformed segment. The row carries no `ownerId` on purpose (ownership is a
 * membership role), so the policy answers it as the org's own row: its
 * OWNER/ADMIN while acting in it, or a platform admin. Selects one column
 * and keys off the URL only — it runs before the policy decides, for any
 * authenticated caller.
 */
export async function resolveOrgResource(
  params: unknown,
  db: Pick<PrismaClient, 'org'> = prisma
): Promise<{ kind: 'org'; id: string; orgId: string } | null> {
  const parsed = orgIdParamSchema.safeParse(params);
  if (!parsed.success) return null;
  const { id } = parsed.data;
  const org = await db.org.findUnique({ where: { id }, select: { id: true } });
  return org ? { kind: 'org', id, orgId: id } : null;
}
