/**
 * Admin Orchestration — Rechunk a knowledge document
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/rechunk
 *
 * Deletes existing chunks and re-runs the chunker + embedder pipeline.
 * Useful after chunker improvements. 409 if the document is currently
 * being processed — guards against races between concurrent rechunks.
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

  if (existing.status === 'processing') {
    throw new ConflictError(`Document ${id} is currently being processed`);
  }

  const document = await rechunkDocument(id);

  log.info('Document rechunked', { documentId: id, adminId: session.user.id });
  return successResponse({ document });
});
