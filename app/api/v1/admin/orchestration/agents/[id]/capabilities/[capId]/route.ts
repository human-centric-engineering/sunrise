/**
 * Admin Orchestration — Detach / update agent↔capability link
 *
 * DELETE /api/v1/admin/orchestration/agents/:id/capabilities/:capId
 *   Removes the pivot row. `capId` is the **`AiCapability.id`**, not
 *   the pivot row id — matches the attach flow.
 * PATCH  /api/v1/admin/orchestration/agents/:id/capabilities/:capId
 *   Body: { isEnabled?, customConfig?, customRateLimit? }
 *   Updates the pivot row in place.
 *
 * Both paths call `capabilityDispatcher.clearCache()` on success.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { bindingEnvVarWarnings } from '@/lib/orchestration/env-template';
import { updateAgentCapabilitySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  assertBindingFieldsUnchanged,
  assertBindingsEditable,
  platformBindingsLocked,
} from '@/lib/orchestration/agents/platform-agent-guard';

type RouteParams = { id: string; capId: string };

function parseIds(raw: RouteParams): { agentId: string; capabilityId: string } {
  const agentIdParse = cuidSchema.safeParse(raw.id);
  const capIdParse = cuidSchema.safeParse(raw.capId);
  const fieldErrors: Record<string, string[]> = {};
  if (!agentIdParse.success) fieldErrors.id = ['Must be a valid CUID'];
  if (!capIdParse.success) fieldErrors.capId = ['Must be a valid CUID'];
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError('Invalid route parameters', fieldErrors);
  }
  return { agentId: agentIdParse.data as string, capabilityId: capIdParse.data as string };
}

/** The agent a binding belongs to, as far as the platform-agent guard reads it. */
async function loadAgent(
  agentId: string
): Promise<{ isSystem: boolean; slug: string; name: string }> {
  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { isSystem: true, slug: true, name: true },
  });
  if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);
  return agent;
}

export const PATCH = withAdminAuth<RouteParams>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const { agentId, capabilityId } = parseIds(await params);

    const body = await validateRequestBody(request, updateAgentCapabilitySchema);

    // On a platform agent the binding's on/off state is the platform's (the
    // reconcile re-enables it); its config and rate limit are the org's, since
    // the reconcile never writes them (§116 t-725). Compared by value, so a
    // dialog that re-sends the unchanged state passes.
    const agent = await loadAgent(agentId);
    if (platformBindingsLocked(agent)) {
      const current = await prisma.aiAgentCapability.findUnique({
        where: { agentId_capabilityId: { agentId, capabilityId } },
        select: { isEnabled: true },
      });
      if (!current) {
        throw new NotFoundError(`Capability ${capabilityId} is not attached to agent ${agentId}`);
      }
      assertBindingFieldsUnchanged(agent, current, body);
    }

    const data: Prisma.AiAgentCapabilityUpdateInput = {};
    if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled;
    if (body.customConfig !== undefined) {
      // null clears the config (the Configure dialog sends it for a blank box).
      // Written as Prisma.JsonNull explicitly, as the attach route does; Prisma 7
      // stores a literal null the same way (JSON null), measured on a real DB.
      data.customConfig =
        body.customConfig === null ? Prisma.JsonNull : (body.customConfig as Prisma.InputJsonValue);
    }
    if (body.customRateLimit !== undefined) data.customRateLimit = body.customRateLimit;

    try {
      const link = await prisma.aiAgentCapability.update({
        where: { agentId_capabilityId: { agentId, capabilityId } },
        data,
      });

      capabilityDispatcher.clearCache();

      log.info('Agent↔capability link updated', {
        agentId,
        capabilityId,
        adminId: session.user.id,
        fieldsChanged: Object.keys(data),
      });

      logAdminAction({
        userId: session.user.id,
        action: 'agent.capability_update',
        entityType: 'agent',
        entityId: agentId,
        metadata: { capabilityId, fieldsChanged: Object.keys(data) },
        clientIp: clientIP,
      });

      const envWarnings = bindingEnvVarWarnings(body.customConfig);
      const meta = envWarnings ? { warnings: envWarnings } : undefined;
      return successResponse(link, meta);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundError(`Capability ${capabilityId} is not attached to agent ${agentId}`);
      }
      throw err;
    }
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Agents and what hangs off them (capabilities, tokens, versions, widget config) are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);

export const DELETE = withAdminAuth<RouteParams>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const { agentId, capabilityId } = parseIds(await params);

    assertBindingsEditable(await loadAgent(agentId));

    try {
      await prisma.aiAgentCapability.delete({
        where: { agentId_capabilityId: { agentId, capabilityId } },
      });

      capabilityDispatcher.clearCache();

      log.info('Capability detached from agent', {
        agentId,
        capabilityId,
        adminId: session.user.id,
      });

      logAdminAction({
        userId: session.user.id,
        action: 'agent.capability_detach',
        entityType: 'agent',
        entityId: agentId,
        metadata: { capabilityId },
        clientIp: clientIP,
      });

      return successResponse({ agentId, capabilityId, detached: true });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundError(`Capability ${capabilityId} is not attached to agent ${agentId}`);
      }
      throw err;
    }
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Agents and what hangs off them (capabilities, tokens, versions, widget config) are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
