/**
 * Admin Orchestration — Agent performance comparison
 *
 * GET /api/v1/admin/orchestration/agents/compare?agentIds=id1,id2
 *
 * Compares two agents side-by-side: configuration, cost totals,
 * conversation counts, evaluation summaries, and capability counts.
 *
 * Authentication: Admin role required.
 *
 * **Every figure is the caller's org's, and every owner's within it** — the
 * first by row isolation, the second by decision (t-682, t-688). The queries
 * and the reasoning live in `getAgentComparisonStats`
 * (`lib/orchestration/agents/agent-comparison.ts`), so the two-tenant smoke can
 * drive them inside a real org. Another org's agent is not visible, so it is a
 * 404 here like any missing id.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';
import { getAgentComparisonStats } from '@/lib/orchestration/agents/agent-comparison';

const querySchema = z.object({
  agentIds: z
    .string()
    .transform((val) => val.split(',').map((s) => s.trim()))
    .pipe(z.array(cuidSchema).length(2, 'Exactly 2 agent IDs required')),
});

export const GET = withAdminAuth(
  async (request) => {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({ agentIds: url.searchParams.get('agentIds') ?? '' });
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        agentIds: parsed.error.issues.map((e) => e.message),
      });
    }

    const [idA, idB] = parsed.data.agentIds;
    const [agentA, agentB] = await Promise.all([
      getAgentComparisonStats(idA),
      getAgentComparisonStats(idB),
    ]);

    const missing = [];
    if (!agentA) missing.push(idA);
    if (!agentB) missing.push(idB);
    if (missing.length > 0) {
      throw new NotFoundError(`Agent(s) not found: ${missing.join(', ')}`);
    }

    return successResponse({ agents: [agentA, agentB] });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Every aggregate is org-wide: row isolation bounds it to the caller’s org, and within that org it counts every owner’s rows on purpose, because this compares two agents rather than the viewer’s use of them. Narrowing would rank two agents by how much the caller happened to use them. Covers all four owner-bearing aggregates — the cost totals, the conversation count and both evaluation counts.',
    },
  }
);
