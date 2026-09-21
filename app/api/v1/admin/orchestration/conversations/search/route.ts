/**
 * Admin Orchestration — Conversation Semantic Search
 *
 * GET /api/v1/admin/orchestration/conversations/search?q=...
 *
 * Embeds the query and performs cosine similarity search against
 * AiMessageEmbedding vectors. Returns conversations ranked by
 * best-matching message, scoped to the calling admin's own
 * conversations. Supports optional filters for agent, status,
 * and date range.
 *
 * When no embedding provider is configured (or embedding fails), returns
 * `{ success: true, data: [], meta: { semanticAvailable: false } }` so the
 * caller can fall back to lexical `?messageSearch=` on the list endpoint.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { searchConversationEmbeddings } from '@/lib/orchestration/chat/conversation-semantic-search';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { logConversationAccess } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';
import { z } from 'zod';

const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  agentId: z.string().optional(),
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  threshold: z.coerce.number().min(0).max(1).default(0.8),
});

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);

  const parsed = searchQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    throw new ValidationError('Invalid search parameters', {
      params: parsed.error.issues.map((i) => i.message),
    });
  }

  const { q, agentId, isActive, dateFrom, dateTo, limit, threshold } = parsed.data;

  // Embed the search query. If no provider is configured or the call
  // fails, signal `semanticAvailable: false` so the caller can fall back
  // to lexical search.
  let queryEmbedding: number[];
  try {
    const embedResult = await embedText(q, 'query', {
      userId: session.user.id,
      metadata: { kind: 'conversation_search' },
    });
    queryEmbedding = embedResult.embedding;
  } catch (err: unknown) {
    log.warn('Conversation semantic search unavailable — embedding failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return successResponse([], { total: 0, semanticAvailable: false });
  }
  if (!queryEmbedding.every((v) => Number.isFinite(v))) {
    log.warn('Embedding returned non-finite values', { sample: queryEmbedding.slice(0, 5) });
    return successResponse([], { total: 0, semanticAvailable: false });
  }
  const results = await searchConversationEmbeddings({
    embedding: queryEmbedding,
    threshold,
    limit,
    callerUserId: session.user.id,
    // Visibility arms and why the ownerless one is a boolean, not data: see
    // the query module.
    includeOwnerless: session.unattributedReads.conversation,
    agentId,
    isActive,
    dateFrom,
    dateTo,
  });

  log.info('Conversation semantic search', {
    query: q,
    resultCount: results.length,
    topDistance: results[0]?.distance,
  });

  // Transform into a response grouped by conversation, ranked by best match
  const seen = new Set<string>();
  const grouped = results
    .filter((r) => {
      if (seen.has(r.conversationId)) return false;
      seen.add(r.conversationId);
      return true;
    })
    .map((r) => ({
      id: r.conversationId,
      conversationId: r.conversationId,
      title: r.conversationTitle,
      agent: r.agentId ? { id: r.agentId, name: r.agentName!, slug: r.agentSlug! } : null,
      agentId: r.agentId,
      userId: r.userId,
      isActive: r.conversationIsActive,
      createdAt: r.conversationCreatedAt,
      updatedAt: r.conversationUpdatedAt,
      _count: { messages: r.messageCount },
      bestMatch: {
        messageId: r.messageId,
        role: r.messageRole,
        content: r.messageContent.slice(0, 500),
        createdAt: r.messageCreatedAt,
        similarity: Math.max(0, 1 - Number(r.distance)),
      },
    }));

  // Audit-of-audits for matches that aren't the caller's own. The OR-subquery
  // in the SQL above pulls in actively-shared conversations, and system-owned
  // inbound threads when the policy admits them, alongside the caller's own;
  // for any returned row the caller doesn't own, write one row under the basis
  // that admitted it. Owner-basis matches no-op via `logConversationAccess`.
  // One log per unique conversation (grouped is already deduped).
  //
  // **The log narrows with the visibility, and that is the correct direction.**
  // Under a policy that refuses unattributed reads, no inbound thread is
  // returned, so none is logged — there was no access to record. What must
  // never happen is the inverse: a row returned without a log. That is why the
  // basis is derived from the row here rather than assumed from the query.
  const clientIp = getClientIP(request);
  for (const row of grouped) {
    if (row.userId === session.user.id) continue;
    logConversationAccess({
      adminUserId: session.user.id,
      conversationId: row.conversationId,
      conversationTitle: row.title,
      conversationOwnerId: row.userId,
      accessBasis: row.userId === null ? 'system' : 'shared',
      action: 'conversation.search_matched',
      extra: {
        query: q,
        similarity: row.bestMatch.similarity,
        messageId: row.bestMatch.messageId,
      },
      clientIp,
    });
  }

  return successResponse(grouped, { total: grouped.length, semanticAvailable: true });
});
