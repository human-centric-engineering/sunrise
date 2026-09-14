/**
 * Admin Orchestration — Single conversation (GET, PATCH, DELETE)
 *
 * GET    /api/v1/admin/orchestration/conversations/:id   — consent-gated read
 * PATCH  /api/v1/admin/orchestration/conversations/:id   — non-sharee mutation
 * DELETE /api/v1/admin/orchestration/conversations/:id   — non-sharee destroy
 *
 * Read access goes through `adminCanViewConversation`: the caller can GET
 * their own conversation, one the owner has actively shared (see
 * `AiConversationShare`), or a system-owned inbound thread. Everything but
 * a self-access writes an audit row.
 *
 * **A share still grants view consent only.** Allowing a sharee admin to
 * PATCH (rename/archive) or DELETE a shared conversation would let them
 * unilaterally modify the sharer's data — outside the consent contract. So
 * mutations accept two of the three bases: `'owner'` and `'system'`.
 *
 * `'system'` is included deliberately. An inbound thread has no owner, so
 * an owner-only rule would leave it permanently un-renameable and
 * un-deletable — including when the person who sent those messages asks for
 * them to be deleted, which is the one erasure request the platform has no
 * other route for (they have no account, so `eraseUser()` doesn't reach
 * them). Both mutations are audit-logged under the `'system'` basis, for the
 * same reason reads are: the person whose record was edited or destroyed has
 * no account here and cannot check for themselves.
 *
 * `AiMessage` rows cascade via the foreign key relation on DELETE.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { updateConversationSchema } from '@/lib/validations/orchestration';
import { adminCanViewConversation } from '@/lib/orchestration/access/conversation-access';
import { logConversationAccess } from '@/lib/orchestration/audit/admin-audit-logger';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const access = await adminCanViewConversation(id, session);
  if (!access.ok) throw new NotFoundError(`Conversation ${id} not found`);

  const conversation = await prisma.aiConversation.findUnique({
    where: { id },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      _count: { select: { messages: true } },
    },
  });
  if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);

  log.info('Conversation fetched', { conversationId: id, accessBasis: access.basis });

  logConversationAccess({
    adminUserId: session.user.id,
    conversationId: id,
    conversationTitle: conversation.title,
    conversationOwnerId: conversation.userId,
    accessBasis: access.basis ?? 'owner',
    action: 'conversation.metadata_viewed',
    clientIp: getClientIP(request),
  });

  return successResponse(conversation);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body: unknown = await request.json();
  const data = updateConversationSchema.parse(body);

  // Own it or nobody owns it. A `'shared'` basis is view-only, so it is
  // rejected here exactly as before.
  const access = await adminCanViewConversation(id, session);
  if (access.basis !== 'owner' && access.basis !== 'system') {
    throw new NotFoundError(`Conversation ${id} not found`);
  }

  const updated = await prisma.aiConversation.update({
    where: { id },
    data,
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      _count: { select: { messages: true } },
    },
  });

  // Renaming or archiving an inbound thread edits a third party's record, so
  // it leaves the same trail a delete does. Self-edits no-op inside the
  // helper. `fields` names what changed without copying the values, which for
  // a `title` would put message content into the audit log.
  logConversationAccess({
    adminUserId: session.user.id,
    conversationId: id,
    conversationTitle: updated.title,
    conversationOwnerId: access.ownerId,
    accessBasis: access.basis,
    action: 'conversation.updated',
    extra: { fields: Object.keys(data) },
    clientIp: getClientIP(request),
  });

  log.info('Conversation updated', {
    conversationId: id,
    fields: Object.keys(data),
    accessBasis: access.basis,
  });
  return successResponse(updated);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // 404 (not 403) if missing, owned by another admin, or merely shared with
  // this one — a view grant is not a destroy grant.
  const access = await adminCanViewConversation(id, session);
  if (access.basis !== 'owner' && access.basis !== 'system') {
    throw new NotFoundError(`Conversation ${id} not found`);
  }

  const existing = await prisma.aiConversation.findUnique({
    where: { id },
    select: { title: true },
  });
  if (!existing) throw new NotFoundError(`Conversation ${id} not found`);

  await prisma.aiConversation.delete({ where: { id } });

  // Destroying an inbound thread destroys a third party's messages. That is
  // often the correct answer to their erasure request, but it is never
  // routine self-service, so it leaves a record naming the admin who did it.
  logConversationAccess({
    adminUserId: session.user.id,
    conversationId: id,
    conversationTitle: existing.title,
    conversationOwnerId: access.ownerId,
    accessBasis: access.basis,
    action: 'conversation.deleted',
    clientIp: getClientIP(request),
  });

  log.info('Conversation deleted', {
    conversationId: id,
    userId: session.user.id,
    accessBasis: access.basis,
  });
  return successResponse({ deleted: true });
});
