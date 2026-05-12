/**
 * Admin Orchestration — Knowledge document chunks
 *
 * GET /api/v1/admin/orchestration/knowledge/documents/:id/chunks
 *
 * Returns all chunks for a given document, ordered by creation.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';

const documentMetaSchema = z
  .object({
    coverage: z
      .object({
        parsedChars: z.number(),
        chunkChars: z.number(),
        coveragePct: z.number(),
      })
      .nullable()
      .optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough()
  .nullable();

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
  const metaParsed = documentMetaSchema.safeParse(document.metadata ?? null);
  const meta = metaParsed.success ? metaParsed.data : null;
  const coverage = meta?.coverage ?? null;
  const warnings = meta?.warnings ?? [];

  log.info('Document chunks fetched', { documentId: id, chunkCount: chunks.length });
  return successResponse({ chunks, coverage, warnings });
});
