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
import { paginatedResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { cuidSchema, paginationQuerySchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(
  async (_request, _session, { params }) => {
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success)
      throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
    const id = parsed.data;

    const agent = await prisma.aiAgent.findUnique({ where: { id }, select: { id: true } });
    if (!agent) throw new NotFoundError(`Agent ${id} not found`);

    const url = new URL(_request.url);
    const { page, limit } = validateQueryParams(url.searchParams, paginationQuerySchema);

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
          // Surface the editor so the history reads as "v3 — model
          // changed (Jane Doe, 12 May 2026)" rather than dropping the
          // operator entirely. The relation already exists on the
          // Prisma model (`AgentVersionCreator`).
          creator: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.aiAgentVersion.count({ where: { agentId: id } }),
    ]);

    return paginatedResponse(versions, { page, limit, total });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Agents and what hangs off them (capabilities, tokens, versions, widget config) are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
