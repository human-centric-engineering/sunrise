/**
 * Admin Orchestration — Clear conversations
 *
 * POST /api/v1/admin/orchestration/conversations/clear
 *
 * Bulk delete conversations matching the supplied filters. At least
 * one of `olderThan` or `agentId` is REQUIRED — an empty body is
 * rejected by the Zod schema to prevent accidental "delete everything"
 * calls.
 *
 * Scope:
 *   - default: caller's own conversations (`session.user.id`)
 *   - `userId`: a specific other user's conversations
 *   - `allUsers: true`: across all users (still narrowed by the
 *     `olderThan` / `agentId` filters), **plus the threads nobody owns** —
 *     inbound SMS / email / Slack conversations carry `userId = null` (#502) —
 *     when the authorization policy permits this caller an unattributed read
 *     of conversations, which a default install does.
 *
 * That last clause is the same rule `DELETE /conversations/:id` applies, and
 * it is here because the two used to disagree: the targeted delete gated an
 * ownerless thread on `adminCanViewConversation` while this route consulted
 * nothing, so a fork narrowing `canRead` refused an admin one inbound thread
 * and let them destroy every inbound thread through the bulk route. A
 * narrowed caller's `allUsers` now means "every user's conversations" and
 * not "every conversation": ownerless rows are in their set exactly when they
 * are in their list. **Only the ownerless arm is policy-gated.** Other users'
 * owned rows stay in `allUsers` (and in the `userId` scope) whatever the
 * policy says, as they always have — this bulk route is wider than the per-id
 * rule by design, and the policy's `subjectScope` is the seam that would
 * narrow that, not this one. The exclusion is recorded on the
 * route log and on the `conversation.bulk_clear` audit row
 * (`metadata.ownerlessExcluded`); the response shape is unchanged.
 *
 * All deletions (including self-scoped) are recorded in the admin audit
 * log so there's an immutable trail. `AiMessage` rows cascade via the
 * foreign-key relation.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { clearConversationsBodySchema } from '@/lib/validations/orchestration';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, clearConversationsBodySchema);

  const scope: 'self' | 'user' | 'all' = body.allUsers ? 'all' : body.userId ? 'user' : 'self';

  // `allUsers` reaches ownerless rows only where the policy admits the caller
  // to them — the answer the guard resolved once, and the same one the
  // targeted DELETE reads through `adminCanViewConversation`.
  const excludeOwnerless = scope === 'all' && !session.unattributedReads.conversation;

  const where: Prisma.AiConversationWhereInput = {};
  if (scope === 'self') where.userId = session.user.id;
  else if (scope === 'user') where.userId = body.userId!;
  else if (excludeOwnerless) where.userId = { not: null };
  if (body.agentId) where.agentId = body.agentId;
  if (body.olderThan) where.createdAt = { lt: new Date(body.olderThan) };

  const result = await prisma.aiConversation.deleteMany({ where });

  log.info('Conversations cleared', {
    scope,
    callerId: session.user.id,
    targetUserId: scope === 'user' ? body.userId : undefined,
    deletedCount: result.count,
    agentId: body.agentId,
    olderThan: body.olderThan,
    // True only for a narrowed caller: inbound threads were left in place
    // because the policy refuses this admin unattributed reads.
    ownerlessExcluded: excludeOwnerless,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'conversation.bulk_clear',
    entityType: 'conversation',
    metadata: {
      scope,
      targetUserId: scope === 'user' ? body.userId : null,
      agentId: body.agentId ?? null,
      olderThan: body.olderThan ?? null,
      deletedCount: result.count,
      // On the immutable row, not only the route log: a compliance reader
      // seeing `scope: 'all'` after an Art. 17 request must be able to tell
      // that a narrowed caller's clear left the inbound threads in place.
      ownerlessExcluded: excludeOwnerless,
    },
    clientIp: clientIP,
  });

  return successResponse({ deletedCount: result.count });
});
