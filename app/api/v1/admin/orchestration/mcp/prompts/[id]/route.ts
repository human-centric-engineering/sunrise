/**
 * Admin MCP — Prompt by ID
 *
 * PATCH  /api/v1/admin/orchestration/mcp/prompts/:id — update
 * DELETE /api/v1/admin/orchestration/mcp/prompts/:id — delete
 *
 * `name` is intentionally NOT updatable — renames silently break every
 * client that has bookmarked or saved the prompt. Admins must delete and
 * recreate to rename.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { clearMcpPromptCache, MAX_ENABLED_PROMPTS } from '@/lib/orchestration/mcp';
import { updatePromptSchema } from '@/lib/validations/mcp';
import { cuidSchema } from '@/lib/validations/common';

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updatePromptSchema);

  const existing = await prisma.mcpExposedPrompt.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Prompt not found');

  // Re-enabling a disabled prompt must also respect the cap.
  if (body.isEnabled === true && !existing.isEnabled) {
    const enabledCount = await prisma.mcpExposedPrompt.count({ where: { isEnabled: true } });
    if (enabledCount >= MAX_ENABLED_PROMPTS) {
      return errorResponse(
        `Cannot enable another prompt — the limit of ${String(MAX_ENABLED_PROMPTS)} has been reached.`,
        { code: 'PROMPT_CAP_EXCEEDED', status: 409 }
      );
    }
  }

  const { argumentsSpec, ...rest } = body;
  const data: Record<string, unknown> = { ...rest };
  if (argumentsSpec !== undefined) {
    data.argumentsSpec = argumentsSpec;
  }

  const updated = await prisma.mcpExposedPrompt.update({
    where: { id },
    data,
  });

  clearMcpPromptCache();

  log.info('MCP prompt updated', {
    adminId: session.user.id,
    promptId: id,
    changedKeys: Object.keys(body),
  });

  return successResponse(updated);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const log = await getRouteLogger(request);

  const existing = await prisma.mcpExposedPrompt.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Prompt not found');

  await prisma.mcpExposedPrompt.delete({ where: { id } });
  clearMcpPromptCache();

  log.info('MCP prompt deleted', {
    adminId: session.user.id,
    promptId: id,
    name: existing.name,
  });

  return successResponse({ id, deleted: true });
});
