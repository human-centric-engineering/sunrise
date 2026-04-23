/**
 * Admin Orchestration — Audit Log (list)
 *
 * GET /api/v1/admin/orchestration/audit-log — paginated audit log with filters
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { listAuditLogQuerySchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, _session) => {
  const clientIp = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIp);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { searchParams } = new URL(request.url);
  const { page, limit, action, entityType, entityId, userId, dateFrom, dateTo, q } =
    validateQueryParams(searchParams, listAuditLogQuerySchema);

  const skip = (page - 1) * limit;

  const where: Prisma.AiAdminAuditLogWhereInput = {};
  if (action) where.action = action;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (userId) where.userId = userId;
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
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.aiAdminAuditLog.count({ where }),
  ]);

  return paginatedResponse(entries, { page, limit, total });
});
