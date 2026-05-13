/**
 * Admin Orchestration — Enrich a knowledge document's BM25 keywords
 *
 * POST /api/v1/admin/orchestration/knowledge/documents/:id/enrich-keywords
 *
 * For every chunk on the document, runs a small chat completion that
 * extracts 3–8 keyword phrases and writes them to
 * `AiKnowledgeChunk.keywords`. Postgres regenerates the `searchVector`
 * generated column automatically, so the BM25 component of hybrid
 * search picks up the new vocabulary on the next query.
 *
 * 409 if the document is currently processing (mirrors `/rechunk`).
 * 503 if no `chat` default model is configured.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  enrichDocumentKeywords,
  NoChunksToEnrichError,
} from '@/lib/orchestration/knowledge/keyword-enricher';
import { NoDefaultModelConfiguredError } from '@/lib/orchestration/llm/settings-resolver';

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
  if (existing.chunkCount === 0) {
    throw new ConflictError(`Document ${id} has no chunks to enrich`);
  }

  let result;
  try {
    result = await enrichDocumentKeywords(id);
  } catch (err) {
    if (err instanceof NoDefaultModelConfiguredError) {
      return errorResponse(
        'No default chat model is configured. Set it in Orchestration → Settings → Default models.',
        { code: 'no_default_model', status: 503 }
      );
    }
    if (err instanceof NoChunksToEnrichError) {
      throw new ConflictError(err.message);
    }
    throw err;
  }

  log.info('Document keywords enriched', {
    documentId: id,
    adminId: session.user.id,
    chunksProcessed: result.chunksProcessed,
    chunksFailed: result.chunksFailed,
    model: result.model,
    costUsd: result.costUsd,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.enrich_keywords',
    entityType: 'knowledge_document',
    entityId: id,
    entityName: existing.fileName,
    metadata: {
      chunksProcessed: result.chunksProcessed,
      chunksSkipped: result.chunksSkipped,
      chunksFailed: result.chunksFailed,
      tokensUsed: result.tokensUsed,
      costUsd: result.costUsd,
      model: result.model,
    },
    clientIp: clientIP,
  });

  return successResponse(result);
});
