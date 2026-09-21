/**
 * Conversation semantic search — the query behind
 * `GET /api/v1/admin/orchestration/conversations/search`.
 *
 * A pgvector cosine-distance query over `ai_message_embedding`, which
 * Prisma's query builder cannot express, so the visibility predicate is SQL
 * (the fourth spelling of the rule `conversationVisibilityWhere` states for
 * the builder). Lives here rather than in the route so the two-org isolation
 * harness (`scripts/smoke/tenancy-isolation.ts`, §107 t-709) can drive the
 * SAME statement under a real policy — a copy of the SQL in the harness would
 * be the thing that drifts. The route embeds the query, calls this, and does
 * the grouping and the access audit.
 *
 * **`includeOwnerless` is the authorization policy's answer, never a
 * caller's choice**: the route passes `session.unattributedReads.conversation`
 * and nothing else may pass `true` without asking the policy first. Note the
 * ownerless-surfaces guard fences THIS module (it names the tables; it sits
 * on the by-design list), not a caller of this export — a new caller is
 * invisible to it, so the obligation lives here, at the seam, in words.
 */
import { prisma } from '@/lib/db/client';

export interface ConversationSearchOptions {
  /** The query embedding, as the pgvector literal expects it. */
  embedding: readonly number[];
  /** Cosine distance below which a message matches. */
  threshold: number;
  limit: number;
  /** Whose conversations are "own" — binds only to the owner branch. */
  callerUserId: string;
  /**
   * Whether the authorization policy permits an unattributed read: the
   * system-owned inbound threads (`"userId" IS NULL`). A fixed string chosen
   * by a boolean, not interpolated data.
   */
  includeOwnerless: boolean;
  agentId?: string;
  isActive?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

export interface ConversationSearchRow {
  conversationId: string;
  conversationTitle: string | null;
  agentId: string | null;
  /** `null` for a system-owned inbound thread, which the ownerless arm admits. */
  userId: string | null;
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
}

/**
 * Rank messages by cosine distance to `embedding`, one row per matching
 * message, nearest first. Grouping by conversation is the caller's.
 */
export async function searchConversationEmbeddings(
  opts: ConversationSearchOptions
): Promise<ConversationSearchRow[]> {
  const { threshold, limit, callerUserId, agentId, isActive, dateFrom, dateTo } = opts;
  const embeddingStr = `[${opts.embedding.join(',')}]`;

  // Build dynamic WHERE conditions.
  //
  // Visibility: caller can see conversations they own, system-owned inbound
  // threads (`"userId" IS NULL`) where the authorization policy permits an
  // unattributed read, and conversations the owner has actively shared. The
  // three arms mirror the three bases in `adminCanViewConversation`; "active"
  // mirrors `isShareActive` there: revokedAt IS NULL AND (expiresAt IS NULL OR
  // expiresAt > now()). The caller id ($4) binds only to the owner branch.
  //
  // **This is the fourth spelling of the rule and the only one that cannot use
  // `conversationVisibilityWhere`** — the search is a pgvector cosine-distance
  // query over `ai_message_embedding`, which Prisma's query builder cannot
  // express, so the predicate is SQL. It is pinned against the fragment in
  // `conversation-access.test.ts` rather than left to drift.
  //
  // The ownerless arm is a **fixed string chosen by a boolean**, not
  // interpolated data: nothing the caller sends reaches the SQL text, and the
  // parameter list is unchanged. Filtering here rather than dropping rows after
  // the query is deliberate — post-filtering would silently return fewer than
  // `limit` rows and leak the existence of the omitted ones through the count.
  const ownerlessArm = opts.includeOwnerless ? ` OR c."userId" IS NULL` : '';
  const conditions: string[] = [
    `(c."userId" = $4${ownerlessArm} OR (c."userId" IS NOT NULL AND EXISTS (
       SELECT 1 FROM "ai_conversation_share" s
       WHERE s."conversationId" = c.id
         AND s."revokedAt" IS NULL
         AND (s."expiresAt" IS NULL OR s."expiresAt" > NOW())
     )))`,
  ];
  const params: unknown[] = [embeddingStr, threshold, limit, callerUserId];
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

  return prisma.$queryRawUnsafe<ConversationSearchRow[]>(sql, ...params);
}
