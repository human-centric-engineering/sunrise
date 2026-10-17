/**
 * Support grants — an org's consent for the vendor's support staff to act
 * inside it (§121 t-823).
 *
 * At `multi` the tenant is the data controller and the platform its processor,
 * so a platform admin entering a customer's org needs the customer's say-so,
 * for a stated time and reason. This module is where that consent is given,
 * replaced and withdrawn, and the rules that make it consent are stated once:
 *
 * - **Only the org's own OWNER, acting in it, may grant.** Not a platform
 *   admin: the policy admits a platform admin to every org's routes, and
 *   lifecycle's owner standing counts them as an owner everywhere, but a
 *   vendor granting itself access to a customer is the thing a grant exists
 *   to prevent. So the check is the principal's verified role *in the org the
 *   URL names*, never platform standing.
 * - **Anyone the policy admits may revoke**: the org's OWNER or ADMIN, or a
 *   platform admin. Ending access is always safe.
 * - **Bounded.** A grant runs `SUPPORT_GRANT_DEFAULT_HOURS` unless the OWNER
 *   names a duration, and never longer than `SUPPORT_GRANT_MAX_HOURS`
 *   (`lib/validations/tenancy.ts`).
 * - **At most one open per org.** A new grant replaces the open one, which is
 *   revoked by the same person in the same SERIALIZABLE transaction, so two
 *   concurrent grants cannot both stand.
 * - **Only where there is someone to let in.** At `single` there is no other
 *   org and no vendor separate from the operator, the install org is the
 *   vendor's own, and a suspended org admits nobody — so each is refused.
 *
 * "Open" is `revokedAt IS NULL AND expiresAt > now`, the one predicate
 * {@link openSupportGrantWhere} states; nothing is written when a grant
 * expires. Grants are never deleted here: an ended grant is history the org
 * reads back.
 *
 * Who may *call* each function is the policy's decision, through the org
 * `resource` the routes hand the guard (`resolveOrgResource`). This module
 * decides what is a valid grant. Entering an org under one is t-824's:
 * `verifiedSupportGrant` in `lib/tenancy/entry.ts`, which adds what entry
 * needs on top of "open" (org active, not the install org, granter still an
 * OWNER).
 *
 * Every function takes a `db` and a `now`, so a test can pass a double and a
 * clock.
 *
 * @see prisma/schema/tenancy.prisma — `OrgSupportGrant`
 * @see .context/tenancy/support-access.md — the guide
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { isSerializableConflict } from '@/lib/db/serializable-conflict';
import { logger } from '@/lib/logging';
import { APIError } from '@/lib/api/errors';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant } from '@/lib/tenancy/context';
import {
  DEFAULT_SUPPORT_GRANT_LEVEL,
  ORG_OWNER_ROLE,
  type SupportGrantLevel,
} from '@/lib/tenancy/roles';
import {
  SUPPORT_GRANT_DEFAULT_HOURS,
  type CreateSupportGrantInput,
} from '@/lib/validations/tenancy';

/** The delegates this module touches. */
export type SupportGrantDb = Pick<PrismaClient, 'org' | 'orgSupportGrant' | '$transaction'>;

/** What a support-grant rule refuses. */
export type SupportGrantErrorCode =
  | 'SUPPORT_NOT_AVAILABLE'
  | 'INSTALL_ORG'
  | 'ORG_NOT_FOUND'
  | 'ORG_NOT_ACTIVE'
  | 'OWNER_REQUIRED'
  | 'GRANT_NOT_FOUND'
  | 'GRANT_CONFLICT';

const STATUS_FOR: Record<SupportGrantErrorCode, number> = {
  SUPPORT_NOT_AVAILABLE: 400,
  INSTALL_ORG: 400,
  ORG_NOT_FOUND: 404,
  ORG_NOT_ACTIVE: 400,
  OWNER_REQUIRED: 403,
  GRANT_NOT_FOUND: 404,
  GRANT_CONFLICT: 409,
};

/**
 * A refused grant change. An `APIError`, as `OrgLifecycleError` is, so a route
 * that lets it propagate answers with the right status and `code`.
 */
export class SupportGrantError extends APIError {
  declare readonly code: SupportGrantErrorCode;

  constructor(code: SupportGrantErrorCode, message: string) {
    super(message, code, STATUS_FOR[code]);
    this.name = 'SupportGrantError';
  }
}

/**
 * Who is changing a grant, from what the guard verified: their id, and the org
 * the request entered with their role in it (`session.principal`). Platform
 * standing is deliberately absent — no rule here reads it.
 */
export interface SupportGrantActor {
  userId: string;
  /** The org the request acts in. Granting needs it to be the org the URL names. */
  orgId: string | null;
  orgRole: string | null;
}

/** The caller as the grant rules read them, off the principal the guard built. */
export function supportGrantActorOf(session: {
  user: { id: string };
  principal: { orgId?: string | null; orgRole?: string | null };
}): SupportGrantActor {
  return {
    userId: session.user.id,
    orgId: session.principal.orgId ?? null,
    orgRole: session.principal.orgRole ?? null,
  };
}

/** A grant as the API returns it. Names, not emails: the org and the vendor both read it. */
export interface SupportGrantRecord {
  id: string;
  orgId: string;
  level: SupportGrantLevel;
  reason: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  grantedBy: { id: string; name: string | null } | null;
  revokedBy: { id: string; name: string | null } | null;
  /** Whether the grant admits support right now. Computed, never stored. */
  open: boolean;
}

const grantSelect = {
  id: true,
  orgId: true,
  level: true,
  reason: true,
  expiresAt: true,
  createdAt: true,
  revokedAt: true,
  grantedBy: { select: { id: true, name: true } },
  revokedBy: { select: { id: true, name: true } },
} satisfies Prisma.OrgSupportGrantSelect;

type GrantRow = Prisma.OrgSupportGrantGetPayload<{ select: typeof grantSelect }>;

function toRecord(row: GrantRow, now: Date): SupportGrantRecord {
  return { ...row, open: row.revokedAt === null && row.expiresAt > now };
}

/** The one statement of "open": not revoked, and not yet expired. */
export function openSupportGrantWhere(now: Date): Prisma.OrgSupportGrantWhereInput {
  return { revokedAt: null, expiresAt: { gt: now } };
}

/**
 * The org's open grant, or `null`. "Open" only: this does NOT decide whether
 * the grant admits anyone. Entry asks `verifiedSupportGrant`
 * (`lib/tenancy/entry.ts`), which also requires the org active, not the
 * install org, and the granter still an OWNER.
 */
export async function findOpenSupportGrant(
  orgId: string,
  db: Pick<PrismaClient, 'orgSupportGrant'> = prisma,
  now: Date = new Date()
): Promise<SupportGrantRecord | null> {
  const row = await db.orgSupportGrant.findFirst({
    where: { orgId, ...openSupportGrantWhere(now) },
    select: grantSelect,
    orderBy: { createdAt: 'desc' },
  });
  return row ? toRecord(row, now) : null;
}

/** How many past grants the list returns. Enough to read a history; not an export. */
export const SUPPORT_GRANT_LIST_LIMIT = 50;

/** The org's grants, newest first: the open one (if any) and the history. */
export async function listSupportGrants(
  orgId: string,
  db: Pick<PrismaClient, 'orgSupportGrant'> = prisma,
  now: Date = new Date()
): Promise<SupportGrantRecord[]> {
  const rows = await db.orgSupportGrant.findMany({
    where: { orgId },
    select: grantSelect,
    orderBy: { createdAt: 'desc' },
    take: SUPPORT_GRANT_LIST_LIMIT,
  });
  return rows.map((row) => toRecord(row, now));
}

/**
 * One audit row made under one of the org's grants (§121 t-825). The action
 * and what it touched, who did it (a name, as on the grant list), and the
 * grant. Not the IP address or the diff: the IP is the support person's
 * personal data, not the org's, and the vendor's own log keeps both.
 */
export interface SupportActivityRecord {
  id: string;
  grantId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  createdAt: Date;
  actor: { id: string; name: string | null } | null;
}

/**
 * The audit rows made under `orgId`'s support grants, newest first — or under
 * one of them, when `grantId` is given.
 *
 * The filter names the grant AND requires it to be this org's, in the one
 * query: a grant id that belongs to another org matches nothing, so a caller
 * admitted to one org cannot read what support did in another by naming its
 * grant. `AiAdminAuditLog` is a system model, so row isolation does not
 * bound this read; the `supportGrant.orgId` condition is what does.
 */
export async function listSupportActivity(
  orgId: string,
  options: { grantId?: string; page: number; limit: number },
  db: Pick<PrismaClient, 'aiAdminAuditLog'> = prisma
): Promise<{ entries: SupportActivityRecord[]; total: number }> {
  const where: Prisma.AiAdminAuditLogWhereInput = {
    supportGrantId: options.grantId ?? { not: null },
    supportGrant: { orgId },
    // Redundant with the grant's org, which is what bounds the read; it lets
    // the query use the `supportOrgId` index instead of joining every support row.
    supportOrgId: orgId,
  };
  const [rows, total] = await Promise.all([
    db.aiAdminAuditLog.findMany({
      where,
      // `id` breaks ties so rows logged in the same millisecond page stably.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (options.page - 1) * options.limit,
      take: options.limit,
      select: {
        id: true,
        supportGrantId: true,
        action: true,
        entityType: true,
        entityId: true,
        entityName: true,
        createdAt: true,
        user: { select: { id: true, name: true } },
      },
    }),
    db.aiAdminAuditLog.count({ where }),
  ]);
  const entries = rows.flatMap(({ supportGrantId, user, ...row }) =>
    supportGrantId ? [{ ...row, grantId: supportGrantId, actor: user }] : []
  );
  return { entries, total };
}

/**
 * Grant support access to the org, replacing the open grant if there is one.
 *
 * Refused at `single`, for the install org, for an org that does not exist or
 * is suspended, and for anyone but an OWNER of this org acting in it. A clash
 * with a concurrent grant for the same org is refused with `GRANT_CONFLICT`
 * (409), and nothing is written. Returns the new grant and the ids of every
 * open grant it revoked, so the route can audit each replacement as well as
 * the grant.
 */
export async function grantSupportAccess(
  orgId: string,
  input: CreateSupportGrantInput,
  actor: SupportGrantActor,
  db: SupportGrantDb = prisma,
  now: Date = new Date()
): Promise<{ grant: SupportGrantRecord; replacedGrantIds: string[] }> {
  if (!isMultiTenant()) {
    throw new SupportGrantError(
      'SUPPORT_NOT_AVAILABLE',
      'Support access is only granted on a multi-tenant install'
    );
  }
  // The install org first: it is the vendor's own, at any role.
  if (orgId === INSTALL_ORG_ID) {
    throw new SupportGrantError(
      'INSTALL_ORG',
      'The install organisation is the platform’s own and takes no support grants'
    );
  }
  if (actor.orgId !== orgId || actor.orgRole !== ORG_OWNER_ROLE) {
    throw new SupportGrantError(
      'OWNER_REQUIRED',
      'Only an owner of this organisation may grant support access'
    );
  }

  const hours = input.durationHours ?? SUPPORT_GRANT_DEFAULT_HOURS;
  const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);

  let result: { created: GrantRow; replacedGrantIds: string[] };
  try {
    result = await db.$transaction(
      async (tx) => {
        // The org's status is read in the transaction, so a suspension that
        // commits first is seen here, and one that commits after is ordered
        // after this grant — which entry then refuses, as it refuses every
        // request to a suspended org.
        const org = await tx.org.findUnique({ where: { id: orgId }, select: { status: true } });
        if (!org) throw new SupportGrantError('ORG_NOT_FOUND', 'Organisation not found');
        if (org.status !== 'ACTIVE') {
          throw new SupportGrantError(
            'ORG_NOT_ACTIVE',
            'A suspended organisation cannot grant support access'
          );
        }
        const open = await tx.orgSupportGrant.findMany({
          where: { orgId, ...openSupportGrantWhere(now) },
          select: { id: true },
        });
        if (open.length > 0) {
          await tx.orgSupportGrant.updateMany({
            where: { id: { in: open.map((g) => g.id) } },
            data: { revokedAt: now, revokedById: actor.userId },
          });
        }
        const created = await tx.orgSupportGrant.create({
          data: {
            orgId,
            level: input.level ?? DEFAULT_SUPPORT_GRANT_LEVEL,
            reason: input.reason,
            expiresAt,
            grantedById: actor.userId,
          },
          select: grantSelect,
        });
        return { created, replacedGrantIds: open.map((g) => g.id) };
      },
      // A read of the open grant, then a write keyed on it: at READ COMMITTED
      // two concurrent grants would each see none open and both stand.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  } catch (error) {
    // SERIALIZABLE failed the later of two concurrent grants (P2034).
    if (isSerializableConflict(error)) {
      throw new SupportGrantError(
        'GRANT_CONFLICT',
        'Another support grant for this organisation was saved at the same time; retry'
      );
    }
    throw error;
  }

  logger.info('Support access granted', {
    orgId,
    grantId: result.created.id,
    level: result.created.level,
    expiresAt: expiresAt.toISOString(),
    replacedGrantIds: result.replacedGrantIds,
    grantedById: actor.userId,
  });
  return { grant: toRecord(result.created, now), replacedGrantIds: result.replacedGrantIds };
}

/**
 * Revoke one of the org's grants. A grant that has already ended — revoked,
 * or expired — is returned as it is with `revoked: false` and nothing written,
 * so a second click or a race with expiry is not an error. A grant id that is
 * not this org's is not found, whatever org it belongs to.
 */
export async function revokeSupportGrant(
  orgId: string,
  grantId: string,
  actor: Pick<SupportGrantActor, 'userId'>,
  db: Pick<PrismaClient, 'orgSupportGrant'> = prisma,
  now: Date = new Date()
): Promise<{ grant: SupportGrantRecord; revoked: boolean }> {
  // Conditional on still being open, so it cannot overwrite an earlier
  // revocation's who-and-when.
  const { count } = await db.orgSupportGrant.updateMany({
    where: { id: grantId, orgId, ...openSupportGrantWhere(now) },
    data: { revokedAt: now, revokedById: actor.userId },
  });

  const row = await db.orgSupportGrant.findFirst({
    where: { id: grantId, orgId },
    select: grantSelect,
  });
  if (!row) throw new SupportGrantError('GRANT_NOT_FOUND', 'Support grant not found');

  if (count > 0) {
    logger.info('Support access revoked', { orgId, grantId, revokedById: actor.userId });
  }
  return { grant: toRecord(row, now), revoked: count > 0 };
}
