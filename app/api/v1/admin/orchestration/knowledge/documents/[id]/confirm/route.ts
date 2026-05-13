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
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { confirmPreview } from '@/lib/orchestration/knowledge/document-manager';
import { confirmDocumentPreviewSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

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
