/**
 * Admin MCP — Exposed Prompts
 *
 * GET  /api/v1/admin/orchestration/mcp/prompts — list prompts (paginated)
 * POST /api/v1/admin/orchestration/mcp/prompts — create prompt
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse, errorResponse } from '@/lib/api/responses';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { clearMcpPromptCache, MAX_ENABLED_PROMPTS } from '@/lib/orchestration/mcp';
import { createPromptSchema, listPromptsQuerySchema } from '@/lib/validations/mcp';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);
  const { page, limit, isEnabled } = validateQueryParams(
    new URL(request.url).searchParams,
    listPromptsQuerySchema
  );

  const where: Record<string, unknown> = {};
  if (isEnabled !== undefined) where.isEnabled = isEnabled;

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.mcpExposedPrompt.findMany({
      where,
      skip,
      take: limit,
      orderBy: { name: 'asc' },
    }),
    prisma.mcpExposedPrompt.count({ where }),
  ]);

  log.info('MCP prompts listed', { count: items.length, total });
  return paginatedResponse(items, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createPromptSchema);

  // Enforce the global enabled-prompt cap. The check is racy in principle
  // (two admins POSTing at the same instant could both pass), but the cap
  // exists to prevent client list-bloat — a one-prompt overshoot is fine.
  if (body.isEnabled) {
    const enabledCount = await prisma.mcpExposedPrompt.count({ where: { isEnabled: true } });
    if (enabledCount >= MAX_ENABLED_PROMPTS) {
      return errorResponse(
        `Cannot create another enabled prompt — the limit of ${String(MAX_ENABLED_PROMPTS)} has been reached. Disable an existing prompt first or create this one disabled.`,
        { code: 'PROMPT_CAP_EXCEEDED', status: 409 }
      );
    }
  }

  const prompt = await prisma.mcpExposedPrompt.create({
    data: {
      name: body.name,
      description: body.description,
      template: body.template,
      argumentsSpec: body.argumentsSpec,
      isEnabled: body.isEnabled,
      createdBy: session.user.id,
    },
  });

  clearMcpPromptCache();

  log.info('MCP prompt created', {
    adminId: session.user.id,
    promptId: prompt.id,
    name: prompt.name,
  });

  return successResponse(prompt, undefined, { status: 201 });
});
