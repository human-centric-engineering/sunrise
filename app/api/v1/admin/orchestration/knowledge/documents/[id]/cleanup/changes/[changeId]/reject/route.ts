/**
 * Admin Orchestration — Reject a pending LLM-rewrite proposal
 *
 *   POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/changes/:changeId/reject
 *
 * Hard-deletes the pending change row. Doc content is unchanged. No
 * revision is written — rejected proposals don't appear in the history.
 *
 * Does NOT require the edit lock — rejecting is purely a delete on the
 * pending row and doesn't touch processedContent.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const POST = withAdminAuth<{ id: string; changeId: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);
    const log = await getRouteLogger(request);

    const { id: rawId, changeId: rawChangeId } = await params;
    const parsedId = cuidSchema.safeParse(rawId);
    const parsedChangeId = cuidSchema.safeParse(rawChangeId);
    if (!parsedId.success) {
      throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
    }
    if (!parsedChangeId.success) {
      throw new ValidationError('Invalid change id', { changeId: ['Must be a valid CUID'] });
    }
    const documentId = parsedId.data;
    const changeId = parsedChangeId.data;

    const doc = await prisma.aiKnowledgeDocument.findFirst({
      where: { id: documentId, uploadedBy: session.user.id, status: 'cleaning' },
      select: { fileName: true },
    });
    if (!doc) {
      throw new ValidationError(
        'Document not found, not owned by this user, or not in cleaning status'
      );
    }

    const deleted = await prisma.aiKnowledgeDocumentPendingChange.deleteMany({
      where: { id: changeId, documentId },
    });
    if (deleted.count === 0) {
      return errorResponse('Pending change not found', {
        code: 'CHANGE_NOT_FOUND',
        status: 404,
        details: { changeId: [changeId] },
      });
    }

    log.info('Cleanup pending change rejected', {
      documentId,
      changeId,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_document.cleanup_reject',
      entityType: 'knowledge_document',
      entityId: documentId,
      entityName: doc.fileName,
      clientIp: clientIP,
    });

    return successResponse({ rejected: true, changeId });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Knowledge documents, their chunks and embeddings are the org’s, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
