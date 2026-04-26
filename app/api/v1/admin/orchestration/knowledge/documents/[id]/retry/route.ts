/**
 * Admin Orchestration — Retry a failed knowledge document
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/retry
 *
 * Resets a failed document to "pending" and re-runs the chunker pipeline.
 * Only works on documents with status "failed".
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { rechunkDocument } from '@/lib/orchestration/knowledge/document-manager';
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

  const existing = await prisma.aiKnowledgeDocument.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError(`Document ${id} not found`);

  if (existing.status !== 'failed') {
    throw new ConflictError(
      `Document ${id} is not in a failed state (current: ${existing.status})`
    );
  }

  // Reset to pending and clear error before reprocessing
  await prisma.aiKnowledgeDocument.update({
    where: { id },
    data: { status: 'pending', errorMessage: null },
  });

  const document = await rechunkDocument(id);

  log.info('Document retried', { documentId: id, adminId: session.user.id });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.retry',
    entityType: 'knowledge_document',
    entityId: id,
    entityName: existing.fileName,
    metadata: { previousStatus: 'failed' },
    clientIp: clientIP,
  });

  return successResponse({ document });
});
