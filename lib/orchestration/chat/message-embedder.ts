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
