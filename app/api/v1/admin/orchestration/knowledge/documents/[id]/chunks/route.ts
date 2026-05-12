/**
 * Admin Orchestration — Knowledge document chunks
 *
 * GET /api/v1/admin/orchestration/knowledge/documents/:id/chunks
 *
 * Returns all chunks for a given document, ordered by creation.
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
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
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

  const document = await prisma.aiKnowledgeDocument.findUnique({ where: { id } });
  if (!document) throw new NotFoundError(`Document ${id} not found`);

  const chunks = await prisma.aiKnowledgeChunk.findMany({
    where: { documentId: id },
    orderBy: { chunkKey: 'asc' },
    select: {
      id: true,
      content: true,
      chunkType: true,
      patternNumber: true,
      patternName: true,
      section: true,
      category: true,
      keywords: true,
      estimatedTokens: true,
    },
  });

  // Surface the coverage metric + warnings the chunk pipeline wrote into
  // `document.metadata` (see lib/orchestration/knowledge/coverage.ts). The
  // admin Chunks Inspector renders these so the operator can see at a
  // glance how much of the parsed text actually made it into chunks.
  const meta = (document.metadata ?? null) as Record<string, unknown> | null;
  const coverage = (meta?.coverage ?? null) as {
    parsedChars: number;
    chunkChars: number;
    coveragePct: number;
  } | null;
  const warnings = Array.isArray(meta?.warnings)
    ? (meta.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
    : [];

  log.info('Document chunks fetched', { documentId: id, chunkCount: chunks.length });
  return successResponse({ chunks, coverage, warnings });
});
