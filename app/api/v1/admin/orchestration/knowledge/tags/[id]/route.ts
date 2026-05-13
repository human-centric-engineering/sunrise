/**
 * Admin Orchestration — Single knowledge tag (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/knowledge/tags/:id
 * PATCH  /api/v1/admin/orchestration/knowledge/tags/:id
 * DELETE /api/v1/admin/orchestration/knowledge/tags/:id?force=true
 *   - Hard delete cascades the doc/agent join rows by FK CASCADE.
 *   - When the tag is granted to one or more agents, returns 409
 *     unconditionally — `force=true` does NOT bypass this. The operator
 *     must remove the grant from each agent first, so a tag-deletion can
 *     never silently strip an agent's knowledge access. The response
 *     includes `details.agents` (up to 50) so the UI can link the
 *     operator to the agents that hold the grant.
 *   - When the tag is only linked to documents (no agents), `?force=true`
 *     still bypasses the 409. Document tagging is descriptive metadata;
 *     forcing a clean-detach there is much safer than for agents.
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

  // Eagerly include the agent grants so we can name them in the 409
  // response when the operator tries to delete a tag that's still bound
  // to one or more agents. Capped at 50 — the dialog lists them as
  // links; beyond 50 we trust the operator to follow up by tag drill-
  // down. Documents are not enumerated here because doc linkage can be
  // force-stripped, so the operator doesn't need the per-row list to
  // make a decision.
  const current = await prisma.knowledgeTag.findUnique({
    where: { id },
    include: {
      _count: { select: { documents: true, agents: true } },
      agents: {
        include: { agent: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      },
    },
  });
  if (!current) throw new NotFoundError(`Knowledge tag ${id} not found`);

  // Agent grants are sacred: deleting a tag that's actively granting an
  // agent access would silently shrink that agent's knowledge scope.
  // Block unconditionally — the operator must remove the grant from
  // each agent first. `force=true` does NOT bypass this guard; it only
  // bypasses the document-only path below.
  if (current._count.agents > 0) {
    throw new ConflictError(
      `Tag "${current.name}" is granted to ${current._count.agents} agent(s). Remove the grant from each agent before deleting this tag.`,
      {
        agentCount: current._count.agents,
        documentCount: current._count.documents,
        agents: current.agents.map((row) => ({
          id: row.agent.id,
          name: row.agent.name,
          slug: row.agent.slug,
        })),
      }
    );
  }

  if (current._count.documents > 0 && !force) {
    throw new ConflictError(
      `Tag "${current.name}" is applied to ${current._count.documents} document(s). Re-send with ?force=true to delete the tag and strip it from those documents.`,
      {
        documentCount: current._count.documents,
        agentCount: 0,
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
