/**
 * An org's own admin history (t-1005, #1181)
 *
 * `AiAdminAuditLog` is the vendor's log: a system model, outside row
 * isolation, read whole by the platform's audit-log page. Every row written
 * inside an org names it (`actingOrgId`, stamped by `logAdminAction`), and
 * this is the one reader that hands an org its own rows. Row isolation does
 * not bound it — the `actingOrgId` filter does, so nothing else may read the
 * table per org. The column is deliberately not `orgId`, which would make the
 * model tenant-owned (`lib/tenancy/classification.ts`) and confine the
 * vendor's cross-org page to one org.
 *
 * Support-session rows are included: what support did in the org happened in
 * it, and `support` says so. `support.enter` is included too, because the
 * switch route stamps the org entered (see `logAdminAction`).
 *
 * Returned per row: what was done and to what, who did it (a name, as on the
 * member list), when, the diff (secrets already redacted at write) and
 * `metadata`. Not the IP address: it is the actor's personal data, not the
 * org's, and the vendor's own log keeps it. Not the actor's email either, for
 * the same reason the support activity list leaves it out.
 *
 * Erasing the org leaves its rows naming it (no FK), as `supportOrgId` does;
 * the org is not a data subject and this is the vendor's record. A person's
 * erasure nulls `userId` as before (`lib/privacy/erase-user.ts`).
 *
 * @see lib/tenancy/support-grants.ts — `listSupportActivity`, the same shape for support rows
 * @see .context/admin/orchestration-audit-log.md
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';

/** One row of an org's admin history. */
export interface OrgAuditRecord {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  changes: Prisma.JsonValue;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  actor: { id: string; name: string | null } | null;
  /** Made inside a support session — the grant it was made under, or null. */
  support: { grantId: string | null } | null;
}

/** Narrowing an org's history. Every filter only narrows; none can widen past the org. */
export interface OrgAuditLogOptions {
  page: number;
  limit: number;
  /** One person's actions. */
  userId?: string;
  /**
   * Rows about these entity types only — a fork's "area" (its design
   * entities, say) is a set of them. An empty list matches nothing.
   */
  entityTypes?: readonly string[];
}

/**
 * The admin audit rows made in `orgId`, newest first. Public: a fork's own
 * org-tier route reads an org's history through this, after its own
 * admission, rather than querying the table under `runAsSystem`.
 *
 * Bounded by `actingOrgId` in the one query, and every option is ANDed onto
 * it: nothing a caller passes can widen the read past the org.
 */
export async function listOrgAuditLog(
  orgId: string,
  options: OrgAuditLogOptions,
  db: Pick<PrismaClient, 'aiAdminAuditLog'> = prisma
): Promise<{ entries: OrgAuditRecord[]; total: number }> {
  const where: Prisma.AiAdminAuditLogWhereInput = {
    actingOrgId: orgId,
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
    ...(options.entityTypes !== undefined ? { entityType: { in: [...options.entityTypes] } } : {}),
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
        action: true,
        entityType: true,
        entityId: true,
        entityName: true,
        changes: true,
        metadata: true,
        createdAt: true,
        supportGrantId: true,
        supportOrgId: true,
        user: { select: { id: true, name: true } },
      },
    }),
    db.aiAdminAuditLog.count({ where }),
  ]);
  const entries = rows.map(({ user, supportGrantId, supportOrgId, ...row }) => ({
    ...row,
    actor: user,
    // `supportOrgId` is what marks a support row: the grant is nulled when an
    // org is erased, the org id is not. Only THIS org's support session: a row
    // filed here explicitly while its actor was in another org's session would
    // otherwise show that org's grant id.
    support: supportOrgId === orgId ? { grantId: supportGrantId } : null,
  }));
  return { entries, total };
}
