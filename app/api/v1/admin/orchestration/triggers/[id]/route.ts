/**
 * Admin Orchestration — Workflow Inbound Trigger Detail
 *
 * GET    /api/v1/admin/orchestration/triggers/:id  — get trigger
 * PATCH  /api/v1/admin/orchestration/triggers/:id  — update fields
 * DELETE /api/v1/admin/orchestration/triggers/:id  — delete trigger
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';

const updateTriggerMetadataSchema = z
  .object({
    eventTypes: z.array(z.string().min(1)).optional(),
    conversationAgentId: z.string().min(1).optional(),
  })
  .passthrough();

const updateTriggerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  metadata: updateTriggerMetadataSchema.optional(),
  /** Pass `null` to clear, a string to rotate. Min 16 chars when set. */
  signingSecret: z.string().min(16).max(512).nullable().optional(),
  isEnabled: z.boolean().optional(),
});

function resolveTriggerId(rawId: string): string {
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid trigger id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = resolveTriggerId(rawId);

  const trigger = await prisma.aiWorkflowTrigger.findUnique({
    where: { id },
    include: {
      workflow: { select: { id: true, name: true, slug: true, isActive: true } },
    },
  });
  if (!trigger) throw new NotFoundError(`Trigger ${id} not found`);

  log.info('Workflow trigger fetched', { triggerId: id });
  return successResponse(toSafeTrigger(trigger));
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = resolveTriggerId(rawId);

  const existing = await prisma.aiWorkflowTrigger.findUnique({
    where: { id },
    include: {
      workflow: { select: { id: true, name: true, slug: true, isActive: true } },
    },
  });
  if (!existing) throw new NotFoundError(`Trigger ${id} not found`);

  const input = await validateRequestBody(request, updateTriggerSchema);

  // HMAC channels require a secret. Reject clearing the secret on an
  // existing hmac trigger.
  if (existing.channel === 'hmac' && input.signingSecret === null) {
    throw new ValidationError('HMAC triggers must keep a signingSecret', {
      signingSecret: ['Cannot clear the signing secret on an hmac trigger'],
    });
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.metadata !== undefined) data.metadata = input.metadata as Prisma.InputJsonValue;
  if (input.signingSecret !== undefined) data.signingSecret = input.signingSecret;
  if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;

  const updated = await prisma.aiWorkflowTrigger.update({
    where: { id },
    data,
    include: {
      workflow: { select: { id: true, name: true, slug: true, isActive: true } },
    },
  });

  log.info('Workflow trigger updated', { triggerId: id });

  logAdminAction({
    userId: session.user.id,
    action: 'workflow_trigger.update',
    entityType: 'workflow_trigger',
    entityId: id,
    entityName: updated.name,
    changes: computeChanges(
      // Don't leak the rotated/cleared signing secret into the audit
      // diff — its presence is recorded via `hasSigningSecret`.
      redactSecrets(existing),
      redactSecrets(updated)
    ),
    clientIp: getClientIP(request),
  });

  return successResponse(toSafeTrigger(updated));
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = resolveTriggerId(rawId);

  const existing = await prisma.aiWorkflowTrigger.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError(`Trigger ${id} not found`);

  await prisma.aiWorkflowTrigger.delete({ where: { id } });

  log.info('Workflow trigger deleted', { triggerId: id });

  logAdminAction({
    userId: session.user.id,
    action: 'workflow_trigger.delete',
    entityType: 'workflow_trigger',
    entityId: id,
    entityName: existing.name,
    metadata: { channel: existing.channel },
    clientIp: getClientIP(request),
  });

  return successResponse({ deleted: true });
});

function toSafeTrigger<T extends { signingSecret: string | null } & Record<string, unknown>>(
  row: T
): Omit<T, 'signingSecret'> & { hasSigningSecret: boolean } {
  const { signingSecret, ...rest } = row;
  return {
    ...rest,
    hasSigningSecret: signingSecret !== null && signingSecret.length > 0,
  };
}

function redactSecrets(
  row: { signingSecret: string | null } & Record<string, unknown>
): Record<string, unknown> {
  const { signingSecret, ...rest } = row;
  return { ...rest, hasSigningSecret: Boolean(signingSecret) };
}
