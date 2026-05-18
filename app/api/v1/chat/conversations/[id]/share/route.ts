/**
 * Consumer Chat — Share / revoke a conversation
 *
 * POST   /api/v1/chat/conversations/:id/share   — grant cross-user
 *                                                 read access to admins
 * DELETE /api/v1/chat/conversations/:id/share   — revoke
 *
 * **Consent-grant routes.** The end user is the conversation's owner;
 * only they can create or revoke a share on their own conversation.
 * Cross-user calls return 404 (not 403) to avoid disclosing existence.
 *
 * Once an active share row exists, any admin can view the conversation
 * via the admin routes (list, detail, messages, provenance). This is
 * the entire mechanism by which cross-user access is granted — without
 * a share, admins see only their own conversations.
 *
 * Audit: every share / revoke writes to the structured route logger.
 * Admin-side reads of the shared conversation produce their own
 * `conversation.*` audit-log entries via `logConversationAccess`.
 *
 * The endpoints are designed for downstream-app consumption — Sunrise
 * is the backend; the UI ("Share with support" button + revoke) lives
 * in the apps that consume this API.
 *
 * Authentication: any authenticated user (owner of the conversation).
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { shareConversationSchema } from '@/lib/validations/orchestration';

/**
 * Default share lifetime when caller omits `expiresInDays`. Seven days
 * matches a typical support-ticket lifecycle. The body schema caps
 * the user-supplied value at 90; this default is applied here, not in
 * the schema, so the schema can stay shared with any future surface
 * that wants a different default.
 */
const DEFAULT_EXPIRES_IN_DAYS = 7;

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // Body is optional — POST with no body grants a default 7-day share
  // with no reason.
  const rawBody: unknown = await request.json().catch(() => ({}));
  const body = shareConversationSchema.parse(rawBody);

  // Ownership: the caller must own the conversation. Active-agent
  // filter mirrors the per-id consumer routes — sharing a conversation
  // whose agent has been deactivated is allowed at the data layer but
  // would be confusing in practice; keep the same guardrail.
  const conversation = await prisma.aiConversation.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true },
  });
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  const expiresInDays = body.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  // Upsert: re-sharing a previously-revoked or expired conversation
  // refreshes the same row (clear revokedAt, set new expiresAt). One
  // row per conversation; unique constraint enforces.
  const share = await prisma.aiConversationShare.upsert({
    where: { conversationId: id },
    create: {
      conversationId: id,
      reason: body.reason ?? null,
      expiresAt,
    },
    update: {
      reason: body.reason ?? null,
      expiresAt,
      revokedAt: null,
    },
  });

  log.info('Conversation share created', {
    conversationId: id,
    shareId: share.id,
    expiresAt: expiresAt.toISOString(),
    hasReason: body.reason !== undefined,
  });

  return successResponse({
    shareId: share.id,
    conversationId: id,
    expiresAt: expiresAt.toISOString(),
  });
});

export const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // Ownership check first — never disclose other users' conversations.
  const conversation = await prisma.aiConversation.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true },
  });
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  // Idempotent: revoking a missing share or already-revoked share both
  // return 200 OK. The client doesn't need to track share existence
  // before calling DELETE; they can just call it.
  const existing = await prisma.aiConversationShare.findUnique({
    where: { conversationId: id },
    select: { id: true, revokedAt: true },
  });

  if (existing && existing.revokedAt === null) {
    await prisma.aiConversationShare.update({
      where: { conversationId: id },
      data: { revokedAt: new Date() },
    });
    log.info('Conversation share revoked', { conversationId: id, shareId: existing.id });
    return successResponse({ revoked: true, conversationId: id });
  }

  log.info('Conversation share revoke is a no-op (no active share)', {
    conversationId: id,
    shareExists: existing !== null,
  });
  return successResponse({ revoked: false, conversationId: id });
});
