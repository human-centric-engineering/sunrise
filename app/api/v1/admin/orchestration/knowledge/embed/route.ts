/**
 * Admin Orchestration — Generate embeddings for knowledge chunks
 *
 * POST /api/v1/admin/orchestration/knowledge/embed
 *
 * Finds all chunks where embedding IS NULL, batches them through the
 * configured embedding provider, and writes vectors back. Can be called
 * repeatedly — only processes chunks that still need embeddings.
 *
 * Requires an active embedding provider (OpenAI API key or local
 * provider like Ollama).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { embedChunks } from '@/lib/orchestration/knowledge/seeder';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  log.info('Embedding generation started', { adminId: session.user.id });

  const result = await embedChunks();

  log.info('Embedding generation completed', { adminId: session.user.id, ...result });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_embedding.generate',
    entityType: 'knowledge_base',
    entityId: 'knowledge-embed',
    metadata: result,
    clientIp: clientIP,
  });

  return successResponse(result);
});
