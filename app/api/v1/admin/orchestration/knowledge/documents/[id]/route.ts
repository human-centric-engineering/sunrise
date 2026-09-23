/**
 * Admin Orchestration — Single knowledge document (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/knowledge/documents/:id
 * PATCH  /api/v1/admin/orchestration/knowledge/documents/:id  (tagIds[])
 * DELETE /api/v1/admin/orchestration/knowledge/documents/:id
 *
 * Knowledge documents are NOT per-user scoped — the knowledge base is
 * a global asset. `deleteDocument` cascades chunk deletion.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { deleteDocument } from '@/lib/orchestration/knowledge/document-manager';
import { cuidSchema } from '@/lib/validations/common';
import { updateKnowledgeDocumentSchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { invalidateAllAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'document id' });

  const document = await prisma.aiKnowledgeDocument.findUnique({
    where: { id },
    include: {
      _count: { select: { chunks: true } },
      tags: { select: { tagId: true } },
      // Pending LLM-rewrite proposals are deliberately NOT included: each
      // carries a full before + after copy of the document text, and the
      // cleanup view re-fetches this route after every chat turn, capability
      // result, section save and restore. The diff modal reads the one
      // proposal it needs from GET .../cleanup/changes/:changeId instead.
    },
  });
  if (!document) throw new NotFoundError(`Document ${id} not found`);

  // Flatten the tag join rows into an id array for the form to bind to.
  const { tags, ...rest } = document;
  const flat = { ...rest, tagIds: (tags ?? []).map((t) => t.tagId) };

  log.info('Document fetched', { documentId: id });
  return successResponse({ document: flat });
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'document id' });

  const existing = await prisma.aiKnowledgeDocument.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!existing) throw new NotFoundError(`Document ${id} not found`);

  const body = await validateRequestBody(request, updateKnowledgeDocumentSchema);

  // Rename: a plain scalar update, independent of the tag join rows.
  if (body.name !== undefined) {
    await prisma.aiKnowledgeDocument.update({
      where: { id },
      data: { name: body.name },
    });
  }

  // Replacing the tag join rows in a transaction keeps the doc in a consistent
  // state if the createMany fails.
  if (body.tagIds !== undefined) {
    await prisma.$transaction(async (tx) => {
      await tx.aiKnowledgeDocumentTag.deleteMany({ where: { documentId: id } });
      if (body.tagIds!.length > 0) {
        await tx.aiKnowledgeDocumentTag.createMany({
          data: body.tagIds!.map((tagId) => ({ documentId: id, tagId })),
          skipDuplicates: true,
        });
      }
    });

    // Doc tags affect every agent that grants any of these tags — easier to
    // invalidate everyone than to compute the affected set.
    invalidateAllAgentAccess();
  }

  log.info('Document updated', {
    documentId: id,
    renamed: body.name !== undefined,
    tagCount: body.tagIds?.length,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.update',
    entityType: 'knowledge_document',
    entityId: id,
    entityName: body.name ?? existing.name,
    metadata: { renamed: body.name !== undefined, tagCount: body.tagIds?.length },
    clientIp: clientIP,
  });

  // Return the updated doc with flattened tagIds so the client can re-seed
  // its local state without a follow-up GET.
  const updated = await prisma.aiKnowledgeDocument.findUnique({
    where: { id },
    include: {
      _count: { select: { chunks: true } },
      tags: { select: { tagId: true } },
    },
  });
  const { tags, ...rest } = updated!;

  return successResponse({ document: { ...rest, tagIds: (tags ?? []).map((t) => t.tagId) } });
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'document id' });

  // Explicit existence check — deleteDocument throws on missing rows;
  // we convert that into a proper 404 before calling it.
  const existing = await prisma.aiKnowledgeDocument.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError(`Document ${id} not found`);

  await deleteDocument(id);

  log.info('Document deleted', { documentId: id, adminId: session.user.id });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.delete',
    entityType: 'knowledge_document',
    entityId: id,
    entityName: existing.fileName,
    clientIp: clientIP,
  });

  return successResponse({ deleted: true });
});
