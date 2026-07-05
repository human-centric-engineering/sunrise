/**
 * Admin Orchestration — Single agent profile (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/agent-profiles/:id — row +
 *        attached `agents` (id, slug, name) so the edit page can show
 *        what's affected by a change.
 * PATCH  /api/v1/admin/orchestration/agent-profiles/:id — update text.
 *        Slug is intentionally not patchable (rename = new profile +
 *        re-point) so URL identifiers stay stable.
 * DELETE /api/v1/admin/orchestration/agent-profiles/:id — hard delete.
 *        The FK on ai_agent.profileId is ON DELETE SET NULL, so
 *        attached agents are cleanly detached (their override texts
 *        remain — they just stop inheriting).
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
import { updateAgentProfileSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

function parseProfileId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent profile id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseProfileId(rawId);

  const profile = await prisma.aiAgentProfile.findUnique({
    where: { id },
    include: {
      agents: {
        select: { id: true, slug: true, name: true, isActive: true },
        orderBy: { name: 'asc' },
      },
    },
  });
  if (!profile) throw new NotFoundError(`Agent profile ${id} not found`);

  log.info('Agent profile fetched', { profileId: id });
  return successResponse(profile);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseProfileId(rawId);

  const current = await prisma.aiAgentProfile.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Agent profile ${id} not found`);

  const body = await validateRequestBody(request, updateAgentProfileSchema);

  const data: Prisma.AiAgentProfileUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.description !== undefined) data.description = body.description;
  if (body.persona !== undefined) data.persona = body.persona;
  if (body.brandVoiceInstructions !== undefined) {
    data.brandVoiceInstructions = body.brandVoiceInstructions;
  }
  if (body.guardrails !== undefined) data.guardrails = body.guardrails;

  const updated = await prisma.aiAgentProfile.update({ where: { id }, data });

  log.info('Agent profile updated', {
    profileId: id,
    adminId: session.user.id,
    fieldsChanged: Object.keys(data),
  });

  logAdminAction({
    userId: session.user.id,
    action: 'agent_profile.update',
    entityType: 'agent_profile',
    entityId: id,
    entityName: updated.name,
    changes: computeChanges(current, updated, { ignoreKeys: ['updatedAt', 'createdAt'] }),
    clientIp: clientIP,
  });

  return successResponse(updated);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseProfileId(rawId);

  const current = await prisma.aiAgentProfile.findUnique({
    where: { id },
    include: { _count: { select: { agents: true } } },
  });
  if (!current) throw new NotFoundError(`Agent profile ${id} not found`);

  // Hard delete — FK on ai_agent.profileId is ON DELETE SET NULL, so the
  // attached agents are detached cleanly. Their own override texts (if
  // any) remain unchanged; the only effect is that they stop inheriting
  // the profile's persona/voice/guardrails.
  await prisma.aiAgentProfile.delete({ where: { id } });

  log.info('Agent profile deleted', {
    profileId: id,
    slug: current.slug,
    adminId: session.user.id,
    detachedAgentCount: current._count.agents,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'agent_profile.delete',
    entityType: 'agent_profile',
    entityId: id,
    entityName: current.name,
    clientIp: clientIP,
    metadata: { detachedAgentCount: current._count.agents },
  });

  return successResponse({ id, deleted: true, detachedAgentCount: current._count.agents });
});
