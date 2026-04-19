/**
 * Admin Orchestration — Agent Version History
 *
 * GET /api/v1/admin/orchestration/agents/:id/versions
 *   - Lists version snapshots for an agent, newest first.
 *   - Paginated via `page` and `limit` query params.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (_request, _session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  const id = parsed.data;

  const agent = await prisma.aiAgent.findUnique({ where: { id }, select: { id: true } });
  if (!agent) throw new NotFoundError(`Agent ${id} not found`);

  const url = new URL(_request.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20')));

  const [versions, total] = await Promise.all([
    prisma.aiAgentVersion.findMany({
      where: { agentId: id },
      orderBy: { version: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        version: true,
        changeSummary: true,
        createdBy: true,
        createdAt: true,
      },
    }),
    prisma.aiAgentVersion.count({ where: { agentId: id } }),
  ]);

  return successResponse(versions, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
});
