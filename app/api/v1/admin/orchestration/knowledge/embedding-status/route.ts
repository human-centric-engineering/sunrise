/**
 * Admin Orchestration — Embedding status
 *
 * GET /api/v1/admin/orchestration/knowledge/embedding-status
 *
 * Lightweight endpoint returning how many chunks have embeddings
 * and whether an active embedding provider is configured.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { prisma } from '@/lib/db/client';
import { canResolveEmbeddingProvider } from '@/lib/orchestration/knowledge/embedder';

export const GET = withAdminAuth(async (_request) => {
  const [total, embeddedRows, hasActiveProvider] = await Promise.all([
    prisma.aiKnowledgeChunk.count(),
    prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM ai_knowledge_chunk WHERE embedding IS NOT NULL
    `,
    // Ask the resolver, not the row count. This used to be
    // `!!activeProviderRow || !!process.env.OPENAI_API_KEY`, which answered
    // "does a provider exist?" — the same question as "can we embed?" only
    // until the embedding chain started consulting the provider-eligibility
    // rule. On a fork whose rule refuses every arm, the row check reports
    // `true` and the admin UI enables "Generate Embeddings" for a run that
    // cannot succeed.
    canResolveEmbeddingProvider(),
  ]);

  const embedded = Number(embeddedRows[0]?.count ?? 0);

  return successResponse({
    total,
    embedded,
    pending: total - embedded,
    hasActiveProvider,
  });
});
