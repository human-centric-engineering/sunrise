/**
 * Admin Orchestration — Audit Log (list)
 *
 * GET /api/v1/admin/orchestration/audit-log — paginated audit log with filters
 *
 * Support rows (§121 t-825): each row carries `supportOrgId` and the grant it
 * was made under (`supportGrant`, with its org), or null for both outside a
 * support session. `support=only|none` and `supportGrantId` filter on them.
 * The grant is null and `supportOrgId` set on a row whose org was erased.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { listAuditLogQuerySchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, _session) => {
  const { searchParams } = new URL(request.url);
  const {
    page,
    limit,
    action,
    entityType,
    entityId,
    userId,
    dateFrom,
    dateTo,
    q,
    support,
    supportGrantId,
  } = validateQueryParams(searchParams, listAuditLogQuerySchema);

  const skip = (page - 1) * limit;

  const where: Prisma.AiAdminAuditLogWhereInput = {};
  if (action) where.action = action;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (userId) where.userId = userId;
  if (support === 'only') where.supportOrgId = { not: null };
  if (support === 'none') where.supportOrgId = null;
  if (supportGrantId) where.supportGrantId = supportGrantId;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = dateFrom;
    if (dateTo) where.createdAt.lte = dateTo;
  }
  if (q) {
    where.OR = [
      { action: { contains: q, mode: 'insensitive' } },
      { entityName: { contains: q, mode: 'insensitive' } },
      { user: { name: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const [entries, total] = await Promise.all([
    prisma.aiAdminAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
        supportGrant: {
          select: { id: true, level: true, org: { select: { id: true, name: true } } },
        },
      },
    }),
    prisma.aiAdminAuditLog.count({ where }),
  ]);

  return paginatedResponse(entries, { page, limit, total });
});
