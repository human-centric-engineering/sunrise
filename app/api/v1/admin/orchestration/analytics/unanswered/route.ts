/**
 * Admin Orchestration — Analytics: Unanswered Questions
 *
 * GET /api/v1/admin/orchestration/analytics/unanswered
 *
 * Returns conversations where the assistant likely couldn't answer,
 * identified by hedging language in assistant replies.
 * Query params: from, to (ISO dates), agentId (CUID), limit (1-100).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { analyticsQuerySchema } from '@/lib/validations/orchestration';
import { getUnansweredQuestions } from '@/lib/orchestration/analytics';

export const GET = withAdminAuth(async (request, session) => {
  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, analyticsQuerySchema);

  const questions = await getUnansweredQuestions(query, session);

  return successResponse({ questions });
});
