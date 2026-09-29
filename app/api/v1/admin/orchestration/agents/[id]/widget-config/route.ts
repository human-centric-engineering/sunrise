/**
 * Admin Orchestration — Agent Widget Config
 *
 * GET   /api/v1/admin/orchestration/agents/:id/widget-config — read resolved config
 * PATCH /api/v1/admin/orchestration/agents/:id/widget-config — update partial config
 *   (refused with 403 on a system agent: the platform owns its widget config)
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { updateWidgetConfigSchema, resolveWidgetConfig } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

type Params = { id: string };

export const GET = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  const agentId = parsed.data;

  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { id: true, widgetConfig: true },
  });
  if (!agent) throw new NotFoundError('Agent not found');

  const config = resolveWidgetConfig(agent.widgetConfig);
  return successResponse({ config });
});

export const PATCH = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  const agentId = parsed.data;
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateWidgetConfigSchema);

  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { id: true, name: true, widgetConfig: true, isSystem: true },
  });
  if (!agent) throw new NotFoundError('Agent not found');
  // `widgetConfig` is platform-owned on a platform agent: the next reconcile
  // writes it back, so an edit is refused rather than quietly undone (§116).
  if (agent.isSystem) {
    throw new ForbiddenError(
      `"${agent.name}" is a platform agent, so its widget config is set by the platform and cannot be changed here.`
    );
  }

  const previous = resolveWidgetConfig(agent.widgetConfig);
  const merged = { ...previous, ...body };

  const updated = await prisma.aiAgent.update({
    where: { id: agentId },
    data: { widgetConfig: merged },
    select: { id: true, widgetConfig: true },
  });

  const next = resolveWidgetConfig(updated.widgetConfig);

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(body) as Array<keyof typeof body>) {
    changes[key as string] = { from: previous[key], to: next[key] };
  }

  logAdminAction({
    userId: session.user.id,
    action: 'agent.widget_config.update',
    entityType: 'agent',
    entityId: agentId,
    entityName: agent.name,
    changes,
    clientIp: clientIP,
  });

  log.info('Widget config updated', { agentId, fieldsChanged: Object.keys(body) });
  return successResponse({ config: next });
});
