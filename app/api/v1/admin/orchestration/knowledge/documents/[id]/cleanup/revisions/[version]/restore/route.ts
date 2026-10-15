/**
 * Admin Orchestration — Restore a cleanup revision
 *
 *   POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/revisions/:version/restore
 *
 * Restores a prior revision's content as the new processedContent. Never
 * destructive — writes a new revision with source='restore' so the
 * timeline preserves the restore as a discrete event.
 *
 * Requires the edit lock (423 LOCK_HELD otherwise) and the doc to be in
 * cleaning status owned by the caller.
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

export const POST = withAdminAuth<{ id: string; version: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);
    const log = await getRouteLogger(request);

    const { id: rawId, version: rawVersion } = await params;
    const parsedId = cuidSchema.safeParse(rawId);
    if (!parsedId.success) {
      throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
    }
    const versionNum = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(versionNum) || versionNum < 1) {
      throw new ValidationError('Invalid version', { version: ['Must be a positive integer'] });
    }
    const documentId = parsedId.data;

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

    const revision = await prisma.aiKnowledgeDocumentRevision.findUnique({
      where: { documentId_version: { documentId, version: versionNum } },
    });
    if (!revision) {
      return errorResponse('Revision not found', {
        code: 'REVISION_NOT_FOUND',
        status: 404,
        details: { version: [String(versionNum)] },
      });
    }

    // Write a new revision with source='restore' — never destructive.
    await writeCleanupContent(documentId, revision.content, {
      source: 'restore',
      actorId: session.user.id,
      instructions: `Restored from v${versionNum}`,
    });

    log.info('Cleanup revision restored', {
      documentId,
      adminId: session.user.id,
      restoredFrom: versionNum,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_document.cleanup_restore',
      entityType: 'knowledge_document',
      entityId: documentId,
      entityName: doc.fileName,
      metadata: { restoredFromVersion: versionNum },
      clientIp: clientIP,
    });

    return successResponse({
      documentId,
      restoredFromVersion: versionNum,
      newContent: revision.content,
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
