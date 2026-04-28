/**
 * Admin Orchestration — Workflow Templates
 *
 * GET /api/v1/admin/orchestration/workflows/templates
 *   - Lists all template workflows (builtin + custom).
 *   - Optional `category` filter from metadata.useCases.
 *   - Optional `source` filter: "builtin" | "custom".
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import type { Prisma } from '@prisma/client';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);
  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const source = url.searchParams.get('source');
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));

  const where: Prisma.AiWorkflowWhereInput = {
    isTemplate: true,
  };

  if (source === 'builtin' || source === 'custom') {
    where.templateSource = source;
  }

  // Category filter searches within metadata.useCases JSON array
  if (category) {
    where.metadata = {
      path: ['useCases'],
      array_contains: category,
    };
  }

  const [templates, total] = await Promise.all([
    prisma.aiWorkflow.findMany({
      where,
      orderBy: [{ templateSource: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        patternsUsed: true,
        templateSource: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.aiWorkflow.count({ where }),
  ]);

  return successResponse(templates, {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
});
