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
 * 403 if the provider-eligibility seam bars the resolved model's provider.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  enrichDocumentKeywords,
  NoChunksToEnrichError,
  ProviderNotPermittedError,
} from '@/lib/orchestration/knowledge/keyword-enricher';
import { NoDefaultModelConfiguredError } from '@/lib/orchestration/llm/settings-resolver';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

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
    if (err instanceof ProviderNotPermittedError) {
      // 403, not 500: the caller is an authenticated admin and nothing is
      // broken — this deployment's provider-eligibility rule bars the provider
      // the chat task default resolves to. Its own code rather than the generic
      // `forbidden`, so a client can tell a policy refusal from a role check.
      // Naming the model and provider is safe here and useful: admin-only
      // route, and both are already shown throughout the orchestration admin.
      return errorResponse(err.message, { code: 'provider_not_permitted', status: 403 });
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
