/**
 * Admin Orchestration — Agent budget status
 *
 * GET /api/v1/admin/orchestration/agents/:id/budget
 *
 * Read-only convenience wrapper over `checkBudget()`. Returns the
 * agent's month-to-date spend, its `monthlyBudgetUsd` limit (null if
 * unset), remaining budget, and a `withinBudget` boolean.
 *
 * NOTE: Budget mutations happen through `PATCH /agents/:id` via
 * `updateAgentSchema.monthlyBudgetUsd`. There is deliberately no PATCH
 * on this path — a second mutation path would fork the audit trail.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { checkBudget } from '@/lib/orchestration/llm/cost-tracker';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const agent = await prisma.aiAgent.findUnique({ where: { id }, select: { id: true } });
  if (!agent) throw new NotFoundError(`Agent ${id} not found`);

  const status = await checkBudget(id);
  log.info('Agent budget status fetched', {
    agentId: id,
    withinBudget: status.withinBudget,
    spent: status.spent,
  });
  return successResponse(status);
});
