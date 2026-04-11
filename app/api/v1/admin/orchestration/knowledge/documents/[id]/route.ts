/**
 * Admin Orchestration — Single knowledge document (GET / DELETE)
 *
 * GET    /api/v1/admin/orchestration/knowledge/documents/:id
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
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { deleteDocument } from '@/lib/orchestration/knowledge/document-manager';
import { cuidSchema } from '@/lib/validations/common';

function parseDocumentId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseDocumentId(rawId);

  const document = await prisma.aiKnowledgeDocument.findUnique({
    where: { id },
    include: { _count: { select: { chunks: true } } },
  });
  if (!document) throw new NotFoundError(`Document ${id} not found`);

  log.info('Document fetched', { documentId: id });
  return successResponse({ document });
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseDocumentId(rawId);

  // Explicit existence check — deleteDocument throws on missing rows;
  // we convert that into a proper 404 before calling it.
  const existing = await prisma.aiKnowledgeDocument.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError(`Document ${id} not found`);

  await deleteDocument(id);

  log.info('Document deleted', { documentId: id, adminId: session.user.id });
  return successResponse({ deleted: true });
});
