/**
 * Admin Orchestration — Registered graders + available judge agents.
 *
 * GET /api/v1/admin/orchestration/evaluations/graders
 *   Returns two lists:
 *     - heuristic graders from the registry (slug, description, etc.)
 *     - judge agents from `AiAgent where kind='judge'` (slug, name,
 *       description, isSystem) — these populate the model-grader
 *       picker in the run-create form.
 *
 * The picker UI groups built-in (isSystem) judges separately from
 * custom (operator-created) judges. Both surface here.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { listGraders } from '@/lib/orchestration/evaluations/graders';
import '@/lib/orchestration/evaluations/graders'; // side-effect: register

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);

  // 1. Heuristic graders (everything except `judge_agent`)
  const allGraders = listGraders().map((g) => {
    const entry = {
      slug: g.slug,
      family: g.family,
      description: g.description,
      referenceRequired: 'referenceRequired' in g ? g.referenceRequired : false,
      defaultConfig: (g.defaultConfig ?? null) as unknown,
    };
    return entry;
  });
  const heuristicGraders = allGraders.filter((g) => g.family === 'heuristic');

  // 2. Judge agents — every kind='judge' agent the caller could pick.
  // Built-ins (isSystem) and custom (admin-created) judges are both
  // included; the UI groups them visually by isSystem.
  const judgeAgents = await prisma.aiAgent.findMany({
    where: { kind: 'judge', isActive: true },
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      isSystem: true,
      model: true,
      provider: true,
    },
  });

  log.info('Listed graders + judge agents', {
    heuristicGraders: heuristicGraders.length,
    judgeAgents: judgeAgents.length,
  });
  return successResponse({ heuristicGraders, judgeAgents });
});
