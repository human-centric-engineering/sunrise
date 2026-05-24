/**
 * Admin Orchestration — Workflow Inbound Triggers
 *
 * GET  /api/v1/admin/orchestration/triggers       — list all triggers (paginated, filterable by channel)
 * POST /api/v1/admin/orchestration/triggers       — create a new trigger
 *
 * Triggers configure HOW a workflow gets fired from an external source
 * (Slack, Postmark email, Twilio SMS / WhatsApp, Meta WhatsApp Cloud,
 * generic HMAC). The inbound route at `/api/v1/inbound/:channel/:slug`
 * looks them up by (channel, workflow.slug, isEnabled) on every fire.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { listInboundChannels } from '@/lib/orchestration/inbound/registry';
import { bootstrapInboundAdapters } from '@/lib/orchestration/inbound/bootstrap';

// Module-level bootstrap so `listInboundChannels()` returns the currently
// enabled adapters (env-driven). Idempotent.
bootstrapInboundAdapters();

const triggerMetadataSchema = z
  .object({
    /** Optional allow-list of normalised eventType values. Empty/missing = accept all. */
    eventTypes: z.array(z.string().min(1)).optional(),
    /** Agent that owns conversations created from this trigger (required for Twilio + WhatsApp Cloud). */
    conversationAgentId: z.string().min(1).optional(),
  })
  .passthrough();

const createTriggerSchema = z
  .object({
    workflowId: z.string().min(1),
    /** Adapter slug: `slack`, `postmark`, `hmac`, `twilio`, `whatsapp_cloud`, ... */
    channel: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'invalid channel slug'),
    name: z.string().min(1).max(200),
    metadata: triggerMetadataSchema.optional(),
    /** Per-trigger HMAC secret for the `hmac` channel; null for env-keyed channels. */
    signingSecret: z.string().min(16).max(512).nullable().optional(),
    isEnabled: z.boolean().optional().default(true),
  })
  .refine(
    (data) => data.channel !== 'hmac' || (data.signingSecret && data.signingSecret.length >= 16),
    {
      message: 'HMAC triggers require a `signingSecret` of at least 16 characters',
      path: ['signingSecret'],
    }
  );

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') ?? 50)));
  const channel = searchParams.get('channel') ?? undefined;
  const workflowId = searchParams.get('workflowId') ?? undefined;

  const where: Prisma.AiWorkflowTriggerWhereInput = {};
  if (channel) where.channel = channel;
  if (workflowId) where.workflowId = workflowId;

  const [triggers, total, enabledChannels] = await Promise.all([
    prisma.aiWorkflowTrigger.findMany({
      where,
      orderBy: [{ channel: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        workflow: { select: { id: true, name: true, slug: true, isActive: true } },
      },
    }),
    prisma.aiWorkflowTrigger.count({ where }),
    Promise.resolve(listInboundChannels()),
  ]);

  log.info('Workflow triggers listed', { count: triggers.length, total, channel });
  return successResponse(triggers.map(toSafeTrigger), {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    enabledChannels,
  });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const log = await getRouteLogger(request);

  const input = await validateRequestBody(request, createTriggerSchema);

  // Workflow must exist; rejecting cleanly here is friendlier than a
  // Prisma foreign-key error in the response.
  const workflow = await prisma.aiWorkflow.findUnique({
    where: { id: input.workflowId },
    select: { id: true, slug: true },
  });
  if (!workflow) {
    throw new ValidationError('Workflow not found', { workflowId: ['Unknown workflow id'] });
  }

  // Warn (but don't reject) if the adapter slug isn't currently
  // registered — the inbound route will 404 until the operator wires
  // the env vars, but that's a deployment concern, not a config error.
  const known = listInboundChannels();
  if (!known.includes(input.channel)) {
    log.warn('Trigger created for unregistered channel', {
      channel: input.channel,
      registered: known,
    });
  }

  let trigger;
  try {
    trigger = await prisma.aiWorkflowTrigger.create({
      data: {
        workflowId: input.workflowId,
        channel: input.channel,
        name: input.name,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        signingSecret: input.signingSecret ?? null,
        isEnabled: input.isEnabled,
        createdBy: session.user.id,
      },
      include: {
        workflow: { select: { id: true, name: true, slug: true, isActive: true } },
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ValidationError('A trigger already exists for this workflow on this channel', {
        channel: ['Duplicate (channel, workflowId) — edit the existing trigger instead'],
      });
    }
    throw err;
  }

  log.info('Workflow trigger created', {
    triggerId: trigger.id,
    channel: trigger.channel,
    workflowId: trigger.workflowId,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'workflow_trigger.create',
    entityType: 'workflow_trigger',
    entityId: trigger.id,
    entityName: trigger.name,
    metadata: { channel: trigger.channel, workflowSlug: workflow.slug },
    clientIp: clientIP,
  });

  return successResponse(toSafeTrigger(trigger), undefined, { status: 201 });
});

/**
 * Strip the `signingSecret` plaintext from API responses — admins set
 * it once and view a `hasSigningSecret: true` flag afterwards. Mirrors
 * the `AiEventHook` serializer's secret-redaction posture.
 */
function toSafeTrigger(
  row: Prisma.AiWorkflowTriggerGetPayload<{
    include: { workflow: { select: { id: true; name: true; slug: true; isActive: true } } };
  }>
) {
  const { signingSecret, ...rest } = row;
  return {
    ...rest,
    hasSigningSecret: signingSecret !== null && signingSecret.length > 0,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === 'P2002';
}
