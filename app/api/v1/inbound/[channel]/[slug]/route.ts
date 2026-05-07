/**
 * Inbound Trigger — start a workflow from a third-party system (Slack,
 * Postmark, generic-HMAC).
 *
 * POST /api/v1/inbound/:channel/:slug
 *
 * Flow:
 *   1. Bootstrap adapters (idempotent module-level call).
 *   2. Resolve adapter by `:channel`. Missing → 404.
 *   3. Read raw body once. Try JSON parse (best-effort).
 *   4. If adapter has `handleHandshake` and it returns a Response, return it.
 *   5. Lookup `AiWorkflowTrigger` by (channel, workflow.slug, isEnabled).
 *      Missing or workflow inactive → 404.
 *   6. Adapter `verify` against raw body. Failure → 401.
 *   7. Adapter `normalise` → channel-agnostic payload.
 *   8. Optional event-type filter from `trigger.metadata.eventTypes`.
 *      Filtered out → 200 `{skipped: 'event_type_filtered'}`.
 *   9. Insert `AiWorkflowExecution` (status `pending`, triggerSource pinned).
 *      Unique violation on (workflowId, triggerExternalId) → 200 `{deduped: true}`.
 *  10. Best-effort `lastFiredAt` update, audit log entry, fire-and-forget engine drain.
 *  11. Return 202 `{executionId}`.
 *
 * See `.context/orchestration/inbound-triggers.md` for the full guide.
 */

import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { inboundLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { slugSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { WorkflowStatus, type WorkflowDefinition } from '@/types/orchestration';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { drainEngine } from '@/lib/orchestration/scheduling/scheduler';
import { bootstrapInboundAdapters } from '@/lib/orchestration/inbound/bootstrap';
import { getInboundAdapter } from '@/lib/orchestration/inbound/registry';

// Module-level bootstrap. Idempotent — first call registers adapters from env.
bootstrapInboundAdapters();

const channelSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'invalid channel');
const triggerSlugSchema = slugSchema.pipe(z.string().max(100));

interface TriggerMetadata {
  /** Optional allow-list of normalised eventType values. Empty/missing = accept all. */
  eventTypes?: string[];
}

function parseMetadata(raw: unknown): TriggerMetadata {
  if (!raw || typeof raw !== 'object') return {};
  const md = raw as Record<string, unknown>;
  const out: TriggerMetadata = {};
  if (Array.isArray(md.eventTypes)) {
    out.eventTypes = md.eventTypes.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string; slug: string }> }
): Promise<Response> {
  const { channel, slug } = await params;
  const clientIP = getClientIP(request);

  // Rate limit — keyed by (channel + IP). Prevents one channel's burst from
  // starving the others; same IP can still hit different channels independently.
  const rateLimit = inboundLimiter.check(`inbound:${channel}:${clientIP}`);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  if (!channelSchema.safeParse(channel).success) {
    return errorResponse('Invalid channel', { code: 'NOT_FOUND', status: 404 });
  }
  if (!triggerSlugSchema.safeParse(slug).success) {
    return errorResponse('Invalid workflow slug', { code: 'NOT_FOUND', status: 404 });
  }

  const adapter = getInboundAdapter(channel);
  if (!adapter) {
    // Channel has no registered adapter. 404 (not 503) so probes can't
    // distinguish "channel doesn't exist" from "channel temporarily disabled".
    return errorResponse('Inbound channel not configured', {
      code: 'NOT_FOUND',
      status: 404,
    });
  }

  // Read raw body once. Empty body is allowed for some channels' probes,
  // so we don't fail here — the adapter decides via verify().
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    logger.warn('Inbound: failed to read request body', {
      channel,
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Bad request', { code: 'VALIDATION_ERROR', status: 400 });
  }

  let bodyParsed: unknown = null;
  if (rawBody.length > 0) {
    try {
      bodyParsed = JSON.parse(rawBody);
    } catch {
      // Not JSON. Some channels (Slack url_verification) always send JSON,
      // but we don't fail here — verify() will decide.
    }
  }

  // Handshake short-circuit (Slack url_verification). Runs BEFORE trigger
  // lookup so the app-install probe succeeds even if no trigger exists yet.
  if (adapter.handleHandshake) {
    const handshakeResponse = adapter.handleHandshake(bodyParsed);
    if (handshakeResponse) {
      logger.info('Inbound: handshake handled', { channel, slug });
      return handshakeResponse;
    }
  }

  // Resolve trigger → workflow → published version.
  const trigger = await prisma.aiWorkflowTrigger.findFirst({
    where: {
      channel,
      isEnabled: true,
      workflow: { slug, isActive: true },
    },
    include: {
      workflow: {
        select: {
          id: true,
          slug: true,
          publishedVersion: { select: { id: true, snapshot: true } },
        },
      },
    },
  });

  if (!trigger) {
    return errorResponse('Trigger not found', { code: 'NOT_FOUND', status: 404 });
  }

  if (!trigger.workflow.publishedVersion) {
    logger.warn('Inbound: workflow has no published version', {
      channel,
      slug,
      workflowId: trigger.workflow.id,
    });
    return errorResponse('Workflow has no published version', {
      code: 'NOT_FOUND',
      status: 404,
    });
  }

  // Verify. Adapters MUST NOT throw — but we wrap anyway as defence in depth.
  let verifyResult;
  try {
    verifyResult = await adapter.verify(request, {
      signingSecret: trigger.signingSecret,
      metadata: (trigger.metadata as Record<string, unknown>) ?? {},
      rawBody,
    });
  } catch (err) {
    logger.error(
      'Inbound: adapter.verify threw',
      err instanceof Error ? err : new Error(String(err)),
      { channel, slug }
    );
    return errorResponse('Unauthorized', { code: 'UNAUTHORIZED', status: 401 });
  }

  if (!verifyResult.valid) {
    // Log the structured reason; never surface it in the response so attackers
    // can't probe which check failed.
    logger.warn('Inbound: signature verification failed', {
      channel,
      slug,
      reason: verifyResult.reason,
      clientIP,
    });
    return errorResponse('Unauthorized', { code: 'UNAUTHORIZED', status: 401 });
  }

  // Normalise. Adapters MUST NOT perform I/O here.
  const normalised = adapter.normalise(bodyParsed, request.headers);

  // Optional event-type allow-list (per-trigger metadata).
  const metadata = parseMetadata(trigger.metadata);
  if (
    metadata.eventTypes &&
    metadata.eventTypes.length > 0 &&
    normalised.eventType &&
    !metadata.eventTypes.includes(normalised.eventType)
  ) {
    logger.info('Inbound: event filtered out by trigger metadata', {
      channel,
      slug,
      eventType: normalised.eventType,
    });
    return successResponse({ skipped: 'event_type_filtered' });
  }

  // Prefer the externalId from verify (e.g. when an adapter derives it from
  // signed material) and fall back to the body-derived value (Slack event_id,
  // Postmark MessageID, generic-HMAC body.eventId).
  const externalId = verifyResult.externalId ?? normalised.externalId ?? null;

  // Dedup scope depends on whether the channel uses a shared signing secret.
  //   - slack / postmark: ONE secret per Sunrise instance, signing envelope does NOT
  //     bind the workflow URL, so a captured request can be replayed against any
  //     other workflow on the same channel. Dedup must be channel-global.
  //   - hmac: per-trigger secret, so a captured request only verifies on the
  //     trigger it was originally intended for. Dedup stays workflow-scoped to
  //     allow unrelated triggers to legitimately reuse the same eventId.
  const dedupKey =
    externalId == null
      ? null
      : channel === 'hmac'
        ? `hmac:${trigger.workflow.id}:${externalId}`
        : `${channel}:${externalId}`;

  // Validate definition before inserting; bail with 500 if the published
  // snapshot is invalid (operator error — surface it).
  const defParsed = workflowDefinitionSchema.safeParse(trigger.workflow.publishedVersion.snapshot);
  if (!defParsed.success) {
    logger.error('Inbound: invalid workflow definition snapshot', {
      channel,
      slug,
      workflowId: trigger.workflow.id,
    });
    return errorResponse('Workflow definition invalid', {
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  }

  const triggerSource = `inbound:${channel}`;
  const inputData: Prisma.InputJsonValue = {
    trigger: normalised.payload as Prisma.InputJsonValue,
    triggerMeta: {
      channel: normalised.channel,
      eventType: normalised.eventType ?? null,
      externalId,
    },
  };

  let executionId: string;
  try {
    const execution = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: trigger.workflow.id,
        versionId: trigger.workflow.publishedVersion.id,
        status: WorkflowStatus.PENDING,
        inputData,
        executionTrace: [],
        userId: trigger.createdBy,
        triggerSource,
        triggerExternalId: externalId,
        dedupKey,
      },
    });
    executionId = execution.id;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      Array.isArray(err.meta?.target) &&
      err.meta.target.includes('dedupKey')
    ) {
      // Replay — vendor re-sent an event we've already enqueued.
      logger.info('Inbound: replay deduped', { channel, slug, externalId });
      return successResponse({ deduped: true });
    }
    logger.error(
      'Inbound: failed to insert execution',
      err instanceof Error ? err : new Error(String(err)),
      { channel, slug }
    );
    return errorResponse('Failed to enqueue execution', {
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  }

  // Best-effort lastFiredAt + audit log. Failures here must not affect the ack.
  void prisma.aiWorkflowTrigger
    .update({ where: { id: trigger.id }, data: { lastFiredAt: new Date() } })
    .catch((updErr: unknown) => {
      logger.warn('Inbound: failed to update lastFiredAt', {
        triggerId: trigger.id,
        error: updErr instanceof Error ? updErr.message : String(updErr),
      });
    });

  logAdminAction({
    userId: trigger.createdBy,
    action: 'workflow_trigger.fire',
    entityType: 'workflow_trigger',
    entityId: trigger.id,
    entityName: trigger.name,
    metadata: {
      channel,
      workflowSlug: slug,
      executionId,
      eventType: normalised.eventType ?? null,
      externalId,
    },
    clientIp: clientIP,
  });

  // Drain the engine fire-and-forget so the workflow starts immediately
  // rather than waiting for the next maintenance tick. Mirrors the schedule
  // dispatch pattern; identical crash handling on failure.
  void drainEngine(
    executionId,
    trigger.workflow,
    defParsed.data as WorkflowDefinition,
    inputData as Record<string, unknown>,
    trigger.createdBy,
    trigger.workflow.publishedVersion.id
  );

  logger.info('Inbound: trigger fired', {
    channel,
    slug,
    triggerId: trigger.id,
    executionId,
    externalId,
  });

  return successResponse(
    { executionId, channel, workflowSlug: slug, status: 'pending' },
    undefined,
    { status: 202 }
  );
}
