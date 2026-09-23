/**
 * Admin Orchestration — Finalise a Document Clean Up session
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/finalise
 *
 * Body: { action: 'commit' | 'use-original' | 'delete' }
 *
 *   commit       — chunk + embed the cleaned processedContent → status='ready'
 *   use-original — chunk + embed the untouched originalContent → status='ready'
 *   delete       — hard-delete the document (and its cleanup conversation)
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { commitCleanupAndChunk } from '@/lib/orchestration/knowledge/document-manager';
import { getEditLockState } from '@/lib/orchestration/knowledge/edit-lock';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const bodySchema = z.object({
  action: z.enum(['commit', 'use-original', 'delete']),
});

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const log = await getRouteLogger(request);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
  }
  const documentId = parsed.data;

  const body = await validateRequestBody(request, bodySchema);

  // Lock check — finalise commits or deletes the document, so it must not
  // run out from under an admin with an in-progress section edit, same
  // guard every other mutating cleanup route applies.
  const lockState = await getEditLockState(documentId);
  if (lockState.active && lockState.heldBy !== session.user.id) {
    return errorResponse('Document is being edited by another admin', {
      code: 'LOCK_HELD',
      status: 423,
      details: { heldBy: [lockState.heldBy ?? 'unknown'] },
    });
  }

  if (body.action === 'delete') {
    // Cascade-delete the cleanup conversation via Prisma's onDelete=Cascade
    // on AiAgentKnowledgeDocument and AiKnowledgeDocumentTag; the
    // AiConversation row is dropped separately because contextType/contextId
    // is a soft pointer, not a FK.
    const existing = await prisma.aiKnowledgeDocument.findFirst({
      where: { id: documentId, uploadedBy: session.user.id, status: 'cleaning' },
      select: { fileName: true, name: true },
    });
    if (!existing) {
      throw new ValidationError(
        'Document not found, not owned by this user, or not in cleaning status'
      );
    }

    await prisma.$transaction([
      prisma.aiConversation.deleteMany({
        where: { contextType: 'knowledge_document', contextId: documentId },
      }),
      prisma.aiKnowledgeDocument.delete({ where: { id: documentId } }),
    ]);

    log.info('Cleanup session deleted', { documentId, adminId: session.user.id });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_document.cleanup_delete',
      entityType: 'knowledge_document',
      entityId: documentId,
      entityName: existing.fileName,
      clientIp: clientIP,
    });

    return successResponse({ deleted: true });
  }

  const document = await commitCleanupAndChunk(documentId, session.user.id, body.action);

  log.info('Cleanup finalised', {
    documentId: document.id,
    action: body.action,
    chunkCount: document.chunkCount,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.cleanup_commit',
    entityType: 'knowledge_document',
    entityId: document.id,
    entityName: document.fileName,
    metadata: { mode: body.action, chunkCount: document.chunkCount },
    clientIp: clientIP,
  });

  return successResponse({ document });
});
