/**
 * Admin Orchestration — Knowledge Tags (list + create)
 *
 * GET  /api/v1/admin/orchestration/knowledge/tags  — paginated list with optional `q` search
 * POST /api/v1/admin/orchestration/knowledge/tags  — create a new tag
 *
 * Tags drive the agent knowledge-access resolver — the managed taxonomy that
 * replaced the legacy free-text `knowledgeCategories[]` column on AiAgent
 * (dropped in Phase 6). See `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts`.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { knowledgeTagCounts } from '@/lib/orchestration/admin/global-config-usage';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { ConflictError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import {
  createKnowledgeTagSchema,
  listKnowledgeTagsQuerySchema,
} from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);

  const { searchParams } = new URL(request.url);
  const { page, limit, q } = validateQueryParams(searchParams, listKnowledgeTagsQuerySchema);
  const skip = (page - 1) * limit;

  const where: Prisma.KnowledgeTagWhereInput = {};
  if (q) {
    where.OR = [
      { slug: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [rawTags, total] = await Promise.all([
    prisma.knowledgeTag.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take: limit,
    }),
    prisma.knowledgeTag.count({ where }),
  ]);

  // Every org's grants and document links (t-731): a tag is global config,
  // and "unused" (the bulk delete's test) must mean unused by any org.
  const counts = await knowledgeTagCounts(rawTags.map((t) => t.id));
  const tags = rawTags.map((tag) => ({
    ...tag,
    documentCount: counts.get(tag.id)?.documents ?? 0,
    agentCount: counts.get(tag.id)?.agents ?? 0,
  }));

  log.info('Knowledge tags listed', { count: tags.length, total, page, limit });

  return paginatedResponse(tags, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createKnowledgeTagSchema);

  try {
    const tag = await prisma.knowledgeTag.create({
      data: {
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
      },
    });

    log.info('Knowledge tag created', {
      tagId: tag.id,
      slug: tag.slug,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_tag.create',
      entityType: 'knowledge_tag',
      entityId: tag.id,
      entityName: tag.name,
      clientIp: clientIP,
    });

    return successResponse(tag, undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`Knowledge tag with slug '${body.slug}' already exists`);
    }
    throw err;
  }
});
