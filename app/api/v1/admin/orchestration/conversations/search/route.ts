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
import { prisma } from '@/lib/db/client';
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
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Build dynamic WHERE conditions.
  //
  // Visibility: caller can see conversations they own, system-owned inbound
  // threads (`"userId" IS NULL`), and conversations the owner has actively
  // shared. The three arms mirror the three bases in
  // `adminCanViewConversation`; "active" mirrors `isShareActive` there:
  // revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now()). The OR is
  // fixed (no params); the caller id ($4) binds only to the owner branch.
  const conditions: string[] = [
    `(c."userId" = $4 OR c."userId" IS NULL OR EXISTS (
       SELECT 1 FROM "ai_conversation_share" s
       WHERE s."conversationId" = c.id
         AND s."revokedAt" IS NULL
         AND (s."expiresAt" IS NULL OR s."expiresAt" > NOW())
     ))`,
  ];
  const params: unknown[] = [embeddingStr, threshold, limit, session.user.id];
  let paramIdx = 5;

  if (agentId) {
    conditions.push(`c."agentId" = $${paramIdx}`);
    params.push(agentId);
    paramIdx++;
  }
  if (isActive !== undefined) {
    conditions.push(`c."isActive" = $${paramIdx}`);
    params.push(isActive);
    paramIdx++;
  }
  if (dateFrom) {
    conditions.push(`m."createdAt" >= $${paramIdx}::timestamptz`);
    params.push(dateFrom);
    paramIdx++;
  }
  if (dateTo) {
    conditions.push(`m."createdAt" <= $${paramIdx}::timestamptz`);
    params.push(dateTo);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  // Cosine similarity search — rank conversations by best-matching message
  const sql = `
    SELECT
      c.id              AS "conversationId",
      c.title           AS "conversationTitle",
      c."agentId",
      c."userId",
      c."isActive"      AS "conversationIsActive",
      c."createdAt"     AS "conversationCreatedAt",
      c."updatedAt"     AS "conversationUpdatedAt",
      (SELECT COUNT(*)::int FROM ai_message m2 WHERE m2."conversationId" = c.id) AS "messageCount",
      m.id              AS "messageId",
      m.role            AS "messageRole",
      m.content         AS "messageContent",
      m."createdAt"     AS "messageCreatedAt",
      a.name            AS "agentName",
      a.slug            AS "agentSlug",
      (e.embedding <=> $1::vector) AS distance
    FROM ai_message_embedding e
    JOIN ai_message m        ON m.id = e."messageId"
    JOIN ai_conversation c   ON c.id = m."conversationId"
    LEFT JOIN ai_agent a     ON a.id = c."agentId"
    WHERE (e.embedding <=> $1::vector) < $2
      ${whereClause}
    ORDER BY (e.embedding <=> $1::vector) ASC
    LIMIT $3
  `;

  const results = await prisma.$queryRawUnsafe<
    Array<{
      conversationId: string;
      conversationTitle: string | null;
      agentId: string | null;
      userId: string;
      conversationIsActive: boolean;
      conversationCreatedAt: Date;
      conversationUpdatedAt: Date;
      messageCount: number;
      messageId: string;
      messageRole: string;
      messageContent: string;
      messageCreatedAt: Date;
      agentName: string | null;
      agentSlug: string | null;
      distance: number;
    }>
  >(sql, ...params);

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

  // Audit-of-audits for matches that aren't the caller's own. The
  // OR-subquery in the SQL above pulls in actively-shared conversations and
  // system-owned inbound threads alongside the caller's own; for any
  // returned row the caller doesn't own, write one row under the basis that
  // admitted it. Owner-basis matches no-op via `logConversationAccess`. One
  // log per unique conversation (grouped is already deduped).
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
