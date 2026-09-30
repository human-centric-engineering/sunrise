/**
 * Admin Orchestration — Workflow Templates
 *
 * GET /api/v1/admin/orchestration/workflows/templates
 *   - The built-in templates, served from code, then the calling org's own
 *     template rows (`lib/orchestration/workflows/template-catalogue.ts`).
 *   - Optional `source` filter: "builtin" | "custom".
 *   - Not paginated: twelve built-ins, and at most `MAX_CUSTOM_TEMPLATES`
 *     of the org's own.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { listWorkflowTemplates } from '@/lib/orchestration/workflows/template-catalogue';

const querySchema = z.object({
  source: z.enum(['builtin', 'custom']).optional(),
});

export const GET = withAdminAuth(async (request) => {
  const { source } = validateQueryParams(new URL(request.url).searchParams, querySchema);
  const templates = await listWorkflowTemplates(source);
  return successResponse(templates);
});
