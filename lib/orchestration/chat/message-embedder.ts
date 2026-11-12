/**
 * Async Message Embedder
 *
 * After each assistant message is persisted, queues an async embedding
 * job to generate and store a vector embedding for semantic search.
 * Non-blocking to the chat stream — failures are logged but do not
 * affect the user experience. Under the LLM privacy layer's `local_only`
 * embeddings policy with no local embedding model, the message is skipped.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { isLocalOnlyEmbeddingRefusal } from '@/lib/orchestration/llm/privacy-stage';
import {
  agentPrivacyScope,
  outsidePrivacyScope,
  runInPrivacyScope,
} from '@/lib/orchestration/privacy/scope';

/**
 * Run `fn` in a privacy scope of its own carrying the agent whose reply is
 * being embedded (t-1010), so the agent's privacy mode applies to the
 * embedding call, and a `local_only` embeddings policy refuses it, as it
 * would inside the turn. A scope of its own, not the turn's: the turn has
 * moved on, and its counts must not change after it wrote them.
 */
function inAgentScope<T>(agentId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return agentId ? runInPrivacyScope(agentPrivacyScope(agentId, undefined), fn) : fn();
}

/**
 * Queue an async embedding for a persisted message.
 *
 * Call this after writing an AiMessage to the database. It runs in the
 * background — do NOT await in the chat stream path.
 *
 * Only embeds assistant messages with meaningful content (>20 chars).
 */
export function queueMessageEmbedding(
  messageId: string,
  content: string,
  attribution?: { agentId?: string; conversationId?: string; userId?: string | null }
): void {
  if (content.length < 20) return;

  // Outside the turn's privacy scope: this runs after the turn has moved on,
  // so its embedding call is not one of the turn's (§127). In one of its own
  // that carries the agent, so the agent's mode still applies.
  void outsidePrivacyScope(() =>
    inAgentScope(attribution?.agentId, () =>
      generateAndStoreEmbedding(messageId, content, attribution)
    )
  ).catch((err: unknown) => {
    // The install requires local embeddings and none is active (§127): the
    // reply is not indexed for search. Expected, so not a warning.
    if (isLocalOnlyEmbeddingRefusal(err)) {
      logger.info('Message embedding skipped: the privacy embeddings policy is local only', {
        messageId,
      });
      return;
    }
    logger.warn('Message embedding failed', {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export interface BackfillResult {
  processed: number;
  failed: number;
}

/**
 * Backfill embeddings for assistant messages that are missing them.
 *
 * Queries AiMessage rows (role = 'assistant', content > 20 chars) that
 * have no corresponding AiMessageEmbedding, and re-embeds them in
 * batches. Called by the unified maintenance tick.
 */
export async function backfillMissingEmbeddings(batchSize: number = 25): Promise<BackfillResult> {
  // With the conversation's agent, so the agent's privacy mode applies to the
  // embedding as it did when the reply was first queued (t-1010): a reply
  // whose embedding the agent's mode refused would otherwise be sent on the
  // next tick.
  const missing = await prisma.$queryRaw<
    Array<{ id: string; content: string; agentId: string | null }>
  >`
    SELECT m.id, m.content, c."agentId"
    FROM ai_message m
    LEFT JOIN ai_conversation c ON c.id = m."conversationId"
    LEFT JOIN ai_message_embedding e ON e."messageId" = m.id
    WHERE m.role = 'assistant'
      AND LENGTH(m.content) > 20
      AND e.id IS NULL
    ORDER BY m."createdAt" DESC
    LIMIT ${batchSize}
  `;

  if (missing.length === 0) return { processed: 0, failed: 0 };

  let failed = 0;
  for (const msg of missing) {
    try {
      await inAgentScope(msg.agentId, () => generateAndStoreEmbedding(msg.id, msg.content));
    } catch (err) {
      failed++;
      logger.warn('Embedding backfill failed for message', {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const processed = missing.length - failed;
  if (processed > 0) {
    logger.info('Embedding backfill completed', { processed, failed });
  }

  return { processed, failed };
}

async function generateAndStoreEmbedding(
  messageId: string,
  content: string,
  attribution?: { agentId?: string; conversationId?: string; userId?: string | null }
): Promise<void> {
  // Truncate very long messages to save embedding costs
  const truncated = content.length > 8000 ? content.slice(0, 8000) : content;

  // Both ids are real rows when the chat handler supplies them; the backfill
  // path has neither in scope and passes nothing, which is the other safe
  // value. Never a placeholder — these are foreign keys (#654).
  const { embedding, model, provider, dimensions } = await embedText(truncated, 'document', {
    ...(attribution?.agentId ? { agentId: attribution.agentId } : {}),
    ...(attribution?.conversationId ? { conversationId: attribution.conversationId } : {}),
    ...(attribution?.userId ? { userId: attribution.userId } : {}),
    metadata: { kind: 'message_embedding', messageId },
  });
  const embeddingStr = `[${embedding.join(',')}]`;

  // A raw INSERT is the one create shape the tenancy chokepoint cannot stamp,
  // so the row's org comes from its parent message — always the same org,
  // and at TENANCY_MODE=multi the subselect sees only the current org's
  // message, so WITH CHECK holds (§107).
  await prisma.$executeRawUnsafe(
    `INSERT INTO ai_message_embedding (
       id, "messageId", embedding,
       "embeddingModel", "embeddingProvider", "embeddingDimension", "orgId"
     )
     VALUES (
       gen_random_uuid(), $1, $2::vector, $3, $4, $5,
       (SELECT "orgId" FROM ai_message WHERE id = $1)
     )
     ON CONFLICT ("messageId") DO UPDATE
       SET embedding = $2::vector,
           "embeddingModel" = $3,
           "embeddingProvider" = $4,
           "embeddingDimension" = $5`,
    messageId,
    embeddingStr,
    model,
    provider,
    dimensions
  );

  logger.debug('Message embedding stored', { messageId });
}
