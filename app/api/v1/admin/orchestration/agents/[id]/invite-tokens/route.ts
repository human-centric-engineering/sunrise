/**
 * Admin — Agent Invite Tokens (list + create)
 *
 * GET  /api/v1/admin/orchestration/agents/:id/invite-tokens
 * POST /api/v1/admin/orchestration/agents/:id/invite-tokens
 *
 * Manage invite tokens for invite_only agents. Tokens grant end-users
 * access to chat with the agent via the consumer chat endpoint.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { createInviteTokenSchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { orgForMint } from '@/lib/tenancy/entry';

type Params = { id: string };

export const GET = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });

  const agent = await prisma.aiAgent.findFirst({
    where: { id: parsed.data },
    select: { id: true },
  });
  if (!agent) throw new NotFoundError('Agent not found');

  const tokens = await prisma.aiAgentInviteToken.findMany({
    where: { agentId: agent.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      token: true,
      label: true,
      maxUses: true,
      useCount: true,
      expiresAt: true,
      revokedAt: true,
      orgId: true,
      createdBy: true,
      createdAt: true,
    },
  });

  return successResponse({ tokens });
});

export const POST = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });

  const agent = await prisma.aiAgent.findFirst({
    where: { id: parsed.data },
    select: { id: true, visibility: true, isActive: true },
  });
  if (!agent) throw new NotFoundError('Agent not found');

  if (!agent.isActive) {
    throw new ValidationError('Cannot create invite tokens for a deactivated agent', {
      isActive: ['Agent must be active'],
    });
  }

  if (agent.visibility !== 'invite_only') {
    throw new ValidationError('Agent must have visibility set to invite_only', {
      visibility: ['Current visibility: ' + agent.visibility],
    });
  }

  const body = await validateRequestBody(request, createInviteTokenSchema);

  const token = await prisma.aiAgentInviteToken.create({
    data: {
      agentId: agent.id,
      label: body.label ?? null,
      maxUses: body.maxUses ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      createdBy: session.user.id,
      // The org the request acts in (§106, t-673): the token admits callers
      // acting in that org and no other (`lib/orchestration/invite-tokens.ts`).
      orgId: orgForMint(),
    },
    select: {
      id: true,
      token: true,
      label: true,
      maxUses: true,
      useCount: true,
      expiresAt: true,
      orgId: true,
      createdAt: true,
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'agent.invite_token_create',
    entityType: 'agent',
    entityId: agent.id,
    metadata: { tokenId: token.id, label: body.label },
    clientIp: clientIP,
  });

  return successResponse({ token }, undefined, { status: 201 });
});
