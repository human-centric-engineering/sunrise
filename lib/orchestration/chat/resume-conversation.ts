/**
 * Resume a surface's conversation
 *
 * A "surface" is a stable place a user returns to that is bound to an entity
 * tuple — `AiConversation.(contextType, contextId)`. Core already **binds**
 * that tuple onto a conversation at creation (`loadOrCreateConversation`) and
 * **injects** entity context for it (`buildContext`), but the only resume path
 * is by an explicit `conversationId`. This closes that gap with the third leg:
 * resolve a surface's most-recent-active conversation by its context tuple.
 *
 * The caller (a surface layer or UI) decides *when* to resume — typically it
 * calls this, then passes the returned id to `streamChat` as `conversationId`
 * (a `null` result ⇒ leave it undefined so a fresh conversation opens, tagged
 * with the same tuple). Keeping the policy in the caller and only the
 * correctly-scoped query in core means a fork never re-derives — and never
 * risks omitting — the `userId` scoping that keeps one user's surface
 * conversation from resuming into another's.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';

/** The surface a conversation is resumed for. All fields required. */
export interface ResumableConversationQuery {
  /** The owning user — the query is always scoped to this user. */
  userId: string;
  agentId: string;
  contextType: string;
  contextId: string;
}

/**
 * Find the user's most-recent **active** conversation for a surface — the
 * `(userId, agentId, contextType, contextId)` tuple — or `null` if none.
 * Ordered by `updatedAt` desc so the surface resumes where the user left off.
 * Scoped to `userId` + `agentId` + `isActive`: it never returns another user's
 * conversation, another agent's, or an archived one.
 */
export async function findResumableConversation(
  query: ResumableConversationQuery
): Promise<string | null> {
  const existing = await prisma.aiConversation.findFirst({
    where: {
      userId: query.userId,
      agentId: query.agentId,
      contextType: query.contextType,
      contextId: query.contextId,
      isActive: true,
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  return existing?.id ?? null;
}
