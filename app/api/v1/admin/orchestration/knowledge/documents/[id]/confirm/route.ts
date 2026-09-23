/**
 * Admin Orchestration — Confirm document preview
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/confirm
 *
 * Confirms a document that was uploaded with the preview step (PDF).
 * Optionally accepts corrected text to replace the auto-extracted content.
 * Proceeds with chunking + embedding after confirmation.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import {
  confirmPreview,
  parseDocumentMetadata,
  transitionToCleanup,
} from '@/lib/orchestration/knowledge/document-manager';
import { confirmDocumentPreviewSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body = await validateRequestBody(request, confirmDocumentPreviewSchema);

  if (body.documentId !== id) {
    throw new ValidationError('Document ID mismatch', {
      documentId: ['Must match the URL parameter'],
    });
  }

  // Check whether the upload requested cleanup. PDFs are flagged at upload
  // time via metadata.runCleanup so we can branch here without re-introducing
  // a runCleanup field on confirmDocumentPreviewSchema.
  const existing = await prisma.aiKnowledgeDocument.findUnique({
    where: { id },
    select: { metadata: true, fileName: true },
  });
  const meta = parseDocumentMetadata(existing?.metadata);
  const wantsCleanup = meta?.runCleanup === true;

  if (wantsCleanup) {
    const content = body.correctedContent || meta?.extractedText || '';
    if (!content.trim()) {
      throw new ValidationError('No content available to clean up', {
        content: ['Provide correctedContent or re-upload — extracted text was empty'],
      });
    }
    const kickoff = await transitionToCleanup(id, content, session.user.id);

    log.info('Document Clean Up session opened (PDF confirm)', {
      documentId: kickoff.document.id,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'knowledge_document.cleanup_start',
      entityType: 'knowledge_document',
      entityId: kickoff.document.id,
      entityName: kickoff.document.fileName,
      clientIp: clientIP,
    });

    return successResponse({ document: kickoff.document, redirectTo: kickoff.redirectTo });
  }

  const document = await confirmPreview(id, session.user.id, body.correctedContent);

  log.info('Document preview confirmed', {
    documentId: document.id,
    chunkCount: document.chunkCount,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.confirm',
    entityType: 'knowledge_document',
    entityId: document.id,
    entityName: document.fileName,
    metadata: { chunkCount: document.chunkCount },
    clientIp: clientIP,
  });

  return successResponse({ document });
});
