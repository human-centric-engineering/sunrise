/**
 * Admin Orchestration — Model Recommendations
 *
 * GET /api/v1/admin/orchestration/provider-models/recommend?intent=thinking
 *
 * Returns scored model recommendations for a given task intent.
 * Uses the decision heuristic:
 *   thinking       → Tier 1 frontier models
 *   doing          → Tier 2 cheap/open models
 *   fast_looping   → Tier 3 infra providers
 *   high_reliability → Tier 4 aggregators
 *   private        → Tier 5 local/sovereign
 *   embedding      → Embedding tier models
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { recommendModels } from '@/lib/orchestration/llm/provider-selector';
import { TASK_INTENTS, type TaskIntent } from '@/types/orchestration';

const intentSchema = z.enum(TASK_INTENTS as unknown as [string, ...string[]]);

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const rawIntent = searchParams.get('intent');

  if (!rawIntent) {
    throw new ValidationError('Missing required query parameter: intent', {
      intent: ['Required'],
    });
  }

  const parsed = intentSchema.safeParse(rawIntent);
  if (!parsed.success) {
    throw new ValidationError(`Invalid intent: ${rawIntent}`, {
      intent: [`Must be one of: ${TASK_INTENTS.join(', ')}`],
    });
  }

  const intent = parsed.data as TaskIntent;
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 5, 1), 20) : 5;

  const recommendations = await recommendModels(intent, { limit });

  log.info('Model recommendations generated', { intent, count: recommendations.length });

  return successResponse({
    intent,
    recommendations,
    heuristic: {
      thinking: 'If it thinks → use frontier models (Tier 1)',
      doing: 'If it does → use cheap/open models (Tier 2)',
      fast_looping: 'If it loops fast → use infra providers (Tier 3)',
      high_reliability: 'If it must not fail → route via aggregators (Tier 4)',
      private: 'If it must stay private → run local (Tier 5)',
      embedding: 'If it needs vector embeddings → use embedding models',
    },
  });
});
