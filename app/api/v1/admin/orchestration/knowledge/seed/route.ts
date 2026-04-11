/**
 * Admin Orchestration — Seed knowledge base
 *
 * POST /api/v1/admin/orchestration/knowledge/seed
 *
 * Triggers `seedFromChunksJson` against the canonical chunks.json bundled
 * at `lib/orchestration/seed/chunks.json`. The seeder is idempotent: if
 * the "Agentic Design Patterns" document already exists it is a no-op,
 * so this endpoint is safe to call on every deploy.
 *
 * Authentication: Admin role required.
 */

import path from 'path';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { seedFromChunksJson } from '@/lib/orchestration/knowledge/seeder';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  const chunksPath = path.join(process.cwd(), 'lib/orchestration/seed/chunks.json');

  log.info('Knowledge seed started', { chunksPath, adminId: session.user.id });

  await seedFromChunksJson(chunksPath);

  log.info('Knowledge seed completed', { adminId: session.user.id });

  return successResponse({ seeded: true });
});
