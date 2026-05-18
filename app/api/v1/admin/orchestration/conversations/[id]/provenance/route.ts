/**
 * Admin Orchestration — Conversation provenance (JSON)
 *
 * GET /api/v1/admin/orchestration/conversations/:id/provenance
 *
 * Returns the per-message provenance bundle for a conversation: the
 * five scalar version pins (`agentVersionId`, `workflowExecutionId`,
 * `workflowVersionId`, `modelId`, `providerSlug`) plus the typed
 * `MessageProvenance` bundle (citations, capability calls, workflow
 * sources) on every message.
 *
 * Mirrors `GET /executions/:id/report` — execution-level audit ↔
 * conversation-level audit. The Markdown variant lives at the sibling
 * `provenance.md` route.
 *
 * Ownership: rows are scoped to `session.user.id`. Cross-user access
 * returns 404.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { messageProvenanceSchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const conversation = await prisma.aiConversation.findUnique({
    where: { id },
    include: {
      agent: { select: { id: true, slug: true, name: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  // Ownership-scoped to the calling admin, matching the export route's
  // posture. Cross-user access returns 404 (not 403) — same shape as
  // "row doesn't exist" so an attacker can't enumerate other users.
  if (!conversation || conversation.userId !== session.user.id) {
    throw new NotFoundError(`Conversation ${id} not found`);
  }

  // Validate every persisted provenance JSON before returning. Failure
  // is non-fatal: a row with malformed provenance returns null in the
  // payload, the caller's renderer / UI degrades gracefully, and the
  // bundle as a whole still lands.
  const messages = conversation.messages.map((msg) => {
    let provenance = null;
    if (msg.provenance !== null) {
      const result = messageProvenanceSchema.safeParse(msg.provenance);
      if (result.success) {
        provenance = result.data;
      } else {
        log.warn('Provenance JSON failed validation, omitting from bundle', {
          conversationId: id,
          messageId: msg.id,
          issues: result.error.issues.length,
        });
      }
    }
    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      capabilitySlug: msg.capabilitySlug,
      toolCallId: msg.toolCallId,
      createdAt: msg.createdAt.toISOString(),
      agentVersionId: msg.agentVersionId,
      workflowExecutionId: msg.workflowExecutionId,
      workflowVersionId: msg.workflowVersionId,
      modelId: msg.modelId,
      providerSlug: msg.providerSlug,
      provenance,
    };
  });

  log.info('Conversation provenance bundle fetched', {
    conversationId: id,
    messageCount: messages.length,
  });

  return successResponse({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      userId: conversation.userId,
      agentId: conversation.agentId,
      agentSlug: conversation.agent?.slug ?? null,
      agentName: conversation.agent?.name ?? null,
      isActive: conversation.isActive,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    },
    messages,
  });
});
