/**
 * Admin Orchestration — Single knowledge tag (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/knowledge/tags/:id
 * PATCH  /api/v1/admin/orchestration/knowledge/tags/:id
 * DELETE /api/v1/admin/orchestration/knowledge/tags/:id?force=true
 *   - Hard delete cascades the doc/agent join rows by FK CASCADE.
 *   - When the tag has linked docs or agents, returns 409 unless `?force=true`
 *     is passed. The admin UI surfaces the link count and re-prompts.
 *
 * Mutations call `invalidateAllAgentAccess()` so the resolver's per-agent
 * cache picks up the new tag membership immediately.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { updateKnowledgeTagSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';

function parseTagId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid tag id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseTagId(rawId);

  // Return the actual linked documents and agents — drives the drill-down in
  // the Tags admin so operators can see exactly which docs/agents a tag
  // covers, not just the count. Capped at 200 each; pagination on this view
  // can come later if a tag ever spans more than that.
  const tag = await prisma.knowledgeTag.findUnique({
    where: { id },
    include: {
      _count: { select: { documents: true, agents: true } },
      documents: {
        include: {
          document: {
            select: { id: true, name: true, fileName: true, scope: true, status: true },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      },
      agents: {
        include: {
          agent: {
            select: { id: true, name: true, slug: true, isActive: true },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      },
    },
  });
  if (!tag) throw new NotFoundError(`Knowledge tag ${id} not found`);

  log.info('Knowledge tag fetched', { tagId: id });

  const { _count, documents, agents, ...rest } = tag;
  return successResponse({
    ...rest,
    documentCount: _count.documents,
    agentCount: _count.agents,
    documents: documents.map((d) => d.document),
    agents: agents.map((a) => a.agent),
  });
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseTagId(rawId);

  const current = await prisma.knowledgeTag.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Knowledge tag ${id} not found`);

  const body = await validateRequestBody(request, updateKnowledgeTagSchema);

  const data: Prisma.KnowledgeTagUpdateInput = {};
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.name !== undefined) data.name = body.name;
  if (body.description !== undefined) data.description = body.description ?? null;

  try {
    const tag = await prisma.knowledgeTag.update({ where: { id }, data });

    // Renaming a tag doesn't change grants, but a slug change can affect
    // backup/export keying. Invalidate the resolver cache to be safe.
    invalidateAllAgentAccess();

    log.info('Knowledge tag updated', {
      tagId: id,
      adminId: session.user.id,
      fieldsChanged: Object.keys(data),
    });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_tag.update',
      entityType: 'knowledge_tag',
      entityId: id,
      entityName: tag.name,
      changes: computeChanges(
        current as unknown as Record<string, unknown>,
        tag as unknown as Record<string, unknown>
      ),
      clientIp: clientIP,
    });

    return successResponse(tag);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`Knowledge tag with slug '${body.slug}' already exists`);
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseTagId(rawId);

  const { searchParams } = new URL(request.url);
  const force = searchParams.get('force') === 'true';

  const current = await prisma.knowledgeTag.findUnique({
    where: { id },
    include: {
      _count: { select: { documents: true, agents: true } },
    },
  });
  if (!current) throw new NotFoundError(`Knowledge tag ${id} not found`);

  const linkedCount = current._count.documents + current._count.agents;
  if (linkedCount > 0 && !force) {
    throw new ConflictError(
      `Tag "${current.name}" is linked to ${current._count.documents} document(s) and ${current._count.agents} agent(s). Re-send with ?force=true to delete anyway.`,
      {
        documentCount: current._count.documents,
        agentCount: current._count.agents,
      }
    );
  }

  await prisma.knowledgeTag.delete({ where: { id } });
  invalidateAllAgentAccess();

  log.info('Knowledge tag deleted', {
    tagId: id,
    slug: current.slug,
    force,
    documentLinks: current._count.documents,
    agentLinks: current._count.agents,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_tag.delete',
    entityType: 'knowledge_tag',
    entityId: id,
    entityName: current.name,
    clientIp: clientIP,
  });

  return successResponse({ id, deleted: true });
});
