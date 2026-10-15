/**
 * Admin Orchestration — Accept a pending LLM-rewrite proposal
 *
 *   POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/changes/:changeId/accept
 *
 * Applies the pending change's afterContent to processedContent, writes a
 * `capability:<slug>` revision, and deletes the pending row.
 *
 * Requires the edit lock (423 LOCK_HELD when held by another admin).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { writeCleanupContent } from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';
import { getEditLockState } from '@/lib/orchestration/knowledge/edit-lock';
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

    // Lock check
    const lockState = await getEditLockState(documentId);
    if (lockState.active && lockState.heldBy !== session.user.id) {
      return errorResponse('Document is being edited by another admin', {
        code: 'LOCK_HELD',
        status: 423,
        details: { heldBy: [lockState.heldBy ?? 'unknown'] },
      });
    }

    const doc = await prisma.aiKnowledgeDocument.findFirst({
      where: { id: documentId, uploadedBy: session.user.id, status: 'cleaning' },
      select: { fileName: true },
    });
    if (!doc) {
      throw new ValidationError(
        'Document not found, not owned by this user, or not in cleaning status'
      );
    }

    const change = await prisma.aiKnowledgeDocumentPendingChange.findFirst({
      where: { id: changeId, documentId },
    });
    if (!change) {
      return errorResponse('Pending change not found', {
        code: 'CHANGE_NOT_FOUND',
        status: 404,
        details: { changeId: [changeId] },
      });
    }

    // The change's afterContent was computed from beforeContent. If another
    // change (or edit) landed on processedContent since then, applying it
    // blind would silently clobber that intervening write — so require the
    // two to still match, same guard as the whole-doc edit route.
    const currentDoc = await prisma.aiKnowledgeDocument.findUnique({
      where: { id: documentId },
      select: { processedContent: true, originalContent: true },
    });
    const currentContent = currentDoc?.processedContent ?? currentDoc?.originalContent ?? '';
    if (currentContent !== change.beforeContent) {
      return errorResponse('Content has changed since this proposal was generated', {
        code: 'CHANGE_STALE',
        status: 409,
        details: { changeId: [changeId] },
      });
    }

    // Apply: writeCleanupContent records a revision with the capability
    // source so the timeline correctly attributes the change to the LLM
    // rewrite that produced it.
    await writeCleanupContent(documentId, change.afterContent, {
      source: `capability:${change.source}`,
      actorId: session.user.id,
      sectionMarker: change.sectionMarker ?? undefined,
      instructions: change.instructions,
    });

    // Hard-delete the pending row — accept/reject are state transitions
    // expressed as deletes (no `status` column on the model).
    await prisma.aiKnowledgeDocumentPendingChange.delete({ where: { id: changeId } });

    log.info('Cleanup pending change accepted', {
      documentId,
      changeId,
      source: change.source,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_document.cleanup_accept',
      entityType: 'knowledge_document',
      entityId: documentId,
      entityName: doc.fileName,
      metadata: { source: change.source, sectionMarker: change.sectionMarker },
      clientIp: clientIP,
    });

    return successResponse({
      accepted: true,
      changeId,
      newContent: change.afterContent,
    });
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
