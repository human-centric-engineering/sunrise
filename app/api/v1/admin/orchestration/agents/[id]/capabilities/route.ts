/**
 * Admin Orchestration — Agent ↔ capability pivot list / attach
 *
 * GET    /api/v1/admin/orchestration/agents/:id/capabilities
 *   Returns every `AiAgentCapability` row for the agent with the related
 *   capability included. Used by the admin Agent edit page's Capabilities
 *   tab to render the "Attached" column.
 *
 * POST   /api/v1/admin/orchestration/agents/:id/capabilities
 *   Body: { capabilityId, isEnabled?, customConfig?, customRateLimit? }
 *   Creates an `AiAgentCapability` pivot row linking the agent to the
 *   capability. Calls `capabilityDispatcher.clearCache()` on success so
 *   the dispatcher re-reads bindings on the next call.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { bindingEnvVarWarnings } from '@/lib/orchestration/env-template';
import { attachAgentCapabilitySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { assertBindingsEditable } from '@/lib/orchestration/agents/platform-agent-guard';

export const GET = withAdminAuth<{ id: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawAgentId } = await params;
    const agentId = validatePathParam(rawAgentId, cuidSchema, { label: 'agent id' });

    const agent = await prisma.aiAgent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);

    const links = await prisma.aiAgentCapability.findMany({
      where: { agentId },
      include: { capability: true },
      orderBy: { capability: { name: 'asc' } },
    });

    log.info('Agent capabilities listed', { agentId, count: links.length });
    return successResponse(links);
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

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const { id: rawAgentId } = await params;
    const agentId = validatePathParam(rawAgentId, cuidSchema, { label: 'agent id' });

    const agent = await prisma.aiAgent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);

    // A platform agent's bindings are the platform's unless its definition
    // leaves them to the org, as mcp-system's does (§116 t-725).
    assertBindingsEditable(agent);

    const body = await validateRequestBody(request, attachAgentCapabilitySchema);

    const capability = await prisma.aiCapability.findUnique({ where: { id: body.capabilityId } });
    if (!capability) throw new NotFoundError(`Capability ${body.capabilityId} not found`);

    try {
      const link = await prisma.aiAgentCapability.create({
        data: {
          agentId,
          capabilityId: body.capabilityId,
          isEnabled: body.isEnabled,
          customConfig: (body.customConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          customRateLimit: body.customRateLimit ?? null,
        },
      });

      capabilityDispatcher.clearCache();

      log.info('Capability attached to agent', {
        agentId,
        capabilityId: body.capabilityId,
        linkId: link.id,
        adminId: session.user.id,
      });

      logAdminAction({
        userId: session.user.id,
        action: 'agent.capability_attach',
        entityType: 'agent',
        entityId: agentId,
        entityName: agent.name,
        metadata: { capabilityId: body.capabilityId, capabilitySlug: capability.slug },
        clientIp: clientIP,
      });

      const envWarnings = bindingEnvVarWarnings(body.customConfig);
      const meta = envWarnings ? { warnings: envWarnings } : undefined;
      return successResponse(link, meta, { status: 201 });
    } catch (err) {
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.agentCapability)) {
        throw new ConflictError(
          `Capability ${body.capabilityId} is already attached to agent ${agentId}`
        );
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
