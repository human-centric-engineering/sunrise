/**
 * Async Message Embedder
 *
 * After each assistant message is persisted, queues an async embedding
 * job to generate and store a vector embedding for semantic search.
 * Non-blocking to the chat stream — failures are logged but do not
 * affect the user experience.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedText } from '@/lib/orchestration/knowledge/embedder';

/**
 * Queue an async embedding for a persisted message.
 *
 * Call this after writing an AiMessage to the database. It runs in the
 * background — do NOT await in the chat stream path.
 *
 * Only embeds assistant messages with meaningful content (>20 chars).
 */
export function queueMessageEmbedding(messageId: string, content: string): void {
  if (content.length < 20) return;

  void generateAndStoreEmbedding(messageId, content).catch((err: unknown) => {
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
  const missing = await prisma.$queryRaw<Array<{ id: string; content: string }>>`
    SELECT m.id, m.content
    FROM ai_message m
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
      await generateAndStoreEmbedding(msg.id, msg.content);
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

async function generateAndStoreEmbedding(messageId: string, content: string): Promise<void> {
  // Truncate very long messages to save embedding costs
  const truncated = content.length > 8000 ? content.slice(0, 8000) : content;

  const embedding = await embedText(truncated, 'document');
  const embeddingStr = `[${embedding.join(',')}]`;

  await prisma.$executeRawUnsafe(
    `INSERT INTO ai_message_embedding (id, "messageId", embedding)
     VALUES (gen_random_uuid(), $1, $2::vector)
     ON CONFLICT ("messageId") DO UPDATE SET embedding = $2::vector`,
    messageId,
    embeddingStr
  );

  logger.debug('Message embedding stored', { messageId });
}
