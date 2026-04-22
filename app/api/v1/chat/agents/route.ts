/**
 * Consumer Chat — Available agents
 *
 * GET /api/v1/chat/agents
 *
 * Lists agents that are publicly visible and active. Returns a minimal
 * payload — no system instructions, provider config, or internal details
 * are exposed to consumers.
 *
 * Authentication: Any authenticated user.
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const agents = await prisma.aiAgent.findMany({
    where: {
      isActive: true,
      visibility: 'public',
    },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
    },
    orderBy: { name: 'asc' },
  });

  log.info('Consumer agents listed', { count: agents.length, userId: session.user.id });
  return successResponse({ agents });
});
