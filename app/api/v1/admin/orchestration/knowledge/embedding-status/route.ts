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
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const [total, embeddedRows, hasProvider] = await Promise.all([
    prisma.aiKnowledgeChunk.count(),
    prisma.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT COUNT(*) as count FROM ai_knowledge_chunk WHERE embedding IS NOT NULL`
    ),
    prisma.aiProviderConfig.findFirst({ where: { isActive: true }, select: { id: true } }),
  ]);

  const embedded = Number(embeddedRows[0].count);
  const hasOpenAiKey = !!process.env['OPENAI_API_KEY'];

  return successResponse({
    total,
    embedded,
    pending: total - embedded,
    hasActiveProvider: !!hasProvider || hasOpenAiKey,
  });
});
