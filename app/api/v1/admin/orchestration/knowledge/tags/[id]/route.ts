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
import { ConflictError, NotFoundError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { updateKnowledgeTagSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { knowledgeTagUsage } from '@/lib/orchestration/admin/global-config-usage';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'tag id' });

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

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'tag id' });

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
      changes: computeChanges(current, tag, { ignoreKeys: ['updatedAt', 'createdAt'] }),
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

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'tag id' });

  const { searchParams } = new URL(request.url);
  const force = searchParams.get('force') === 'true';

  const current = await prisma.knowledgeTag.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Knowledge tag ${id} not found`);

  // In every org (t-731): the tag is global config, and a grant or a
  // document link in another org is as real as one in the caller's. The
  // caller's granted agents are named (at most 50, which the dialog lists as
  // links); another org's are a count.
  const usage = await knowledgeTagUsage(id);

  // Agent grants are sacred: deleting a tag that's actively granting an
  // agent access would silently shrink that agent's knowledge scope.
  // Block unconditionally — the operator must remove the grant from
  // each agent first. `force=true` does NOT bypass this guard; it only
  // bypasses the document-only path below.
  if (usage.agentGrants > 0) {
    const elsewhere =
      usage.otherOrgAgentGrants > 0
        ? ` (${usage.otherOrgAgentGrants} of them in other organisations)`
        : '';
    throw new ConflictError(
      `Tag "${current.name}" is granted to ${usage.agentGrants} agent(s)${elsewhere}. Remove the grant from each agent before deleting this tag.`,
      {
        agentCount: usage.agentGrants,
        documentCount: usage.documentLinks,
        otherOrgAgentCount: usage.otherOrgAgentGrants,
        agents: usage.agents,
      }
    );
  }

  if (usage.documentLinks > 0 && !force) {
    throw new ConflictError(
      `Tag "${current.name}" is applied to ${usage.documentLinks} document(s). Re-send with ?force=true to delete the tag and strip it from those documents.`,
      {
        documentCount: usage.documentLinks,
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
    documentLinks: usage.documentLinks,
    agentLinks: usage.agentGrants,
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
