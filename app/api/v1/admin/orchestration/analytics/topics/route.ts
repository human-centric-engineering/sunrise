/**
 * Admin Orchestration — Analytics: Popular Topics
 *
 * GET /api/v1/admin/orchestration/analytics/topics
 *
 * Returns the most frequently asked user messages, grouped by content.
 * Query params: from, to (ISO dates), agentId (CUID), limit (1-100).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { analyticsQuerySchema } from '@/lib/validations/orchestration';
import { getPopularTopics } from '@/lib/orchestration/analytics';

export const GET = withAdminAuth(
  async (request, session) => {
    const { searchParams } = new URL(request.url);
    const query = validateQueryParams(searchParams, analyticsQuerySchema);

    const topics = await getPopularTopics(query, session);

    return successResponse({ topics });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'self',
      because:
        "Figures count every member's conversations in the entered org and carry no message text (`acrossOwners`); any quoted message comes only from conversations this caller may open, keyed on the caller's id (§115 t-802).",
    },
  }
);
