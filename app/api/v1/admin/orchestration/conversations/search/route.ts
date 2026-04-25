/**
 * Admin Orchestration — Conversation Semantic Search
 *
 * GET /api/v1/admin/orchestration/conversations/search?q=...
 *
 * Embeds the query and performs cosine similarity search against
 * AiMessageEmbedding vectors. Returns conversations ranked by
 * best-matching message, with optional filters for agent, user,
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
import { z } from 'zod';

const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  agentId: z.string().optional(),
  userId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  threshold: z.coerce.number().min(0).max(1).default(0.8),
});

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);

  const parsed = searchQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    throw new ValidationError('Invalid search parameters', {
      params: parsed.error.issues.map((i) => i.message),
    });
  }

  const { q, agentId, userId, dateFrom, dateTo, limit, threshold } = parsed.data;

  // Embed the search query. If no provider is configured or the call
  // fails, signal `semanticAvailable: false` so the caller can fall back
  // to lexical search.
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(q, 'query');
  } catch (err: unknown) {
    log.warn('Conversation semantic search unavailable — embedding failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return successResponse([], { total: 0, semanticAvailable: false });
  }
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Build dynamic WHERE conditions
  const conditions: string[] = [];
  const params: unknown[] = [embeddingStr, threshold, limit];
  let paramIdx = 4;

  if (agentId) {
    conditions.push(`c."agentId" = $${paramIdx}`);
    params.push(agentId);
    paramIdx++;
  }
  if (userId) {
    conditions.push(`c."userId" = $${paramIdx}`);
    params.push(userId);
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
        similarity: 1 - Number(r.distance),
      },
    }));

  return successResponse(grouped, { total: grouped.length, semanticAvailable: true });
});
