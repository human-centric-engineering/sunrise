/**
 * Async Message Embedder
 *
 * After each assistant message is persisted, queues an async embedding
 * job to generate and store a vector embedding for semantic search.
 * Non-blocking to the chat stream — failures are logged but do not
 * affect the user experience. A reply the LLM privacy layer refuses to embed
 * (its `local_only` embeddings policy with no local model, say) is recorded
 * as refused, and the backfill asks again only after a back-off (§127 t-1016).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import {
  isLocalOnlyEmbeddingRefusal,
  PrivacyRefusedError,
} from '@/lib/orchestration/llm/privacy-stage';
import {
  createPrivacyScope,
  outsidePrivacyScope,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';

/**
 * Run `fn` in a privacy scope of its own carrying the agent whose reply is
 * being embedded (t-1010), so the agent's privacy mode applies to the
 * embedding call, and a `local_only` embeddings policy refuses it, as it
 * would inside the turn. A scope of its own with no parent, not the turn's:
 * the turn has moved on, and its counts must not change after it wrote them.
 * Nothing reads its counts, so the stage does not scan for them.
 */
function inAgentScope<T>(
  agentId: string | null | undefined,
  fn: () => Promise<T>,
  scopes?: Map<string, PrivacyScope>
): Promise<T> {
  if (!agentId) return fn();
  // One scope per agent across a backfill batch, so its settings are read
  // once for the batch rather than once per message.
  let scope = scopes?.get(agentId);
  if (!scope) {
    scope = createPrivacyScope({
      scopeId: `message-embedding:agent:${agentId}`,
      agentId,
      recordsNowhere: true,
    });
    scopes?.set(agentId, scope);
  }
  return runInPrivacyScope(scope, fn);
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
  ).catch(async (err: unknown) => {
    // Refused: recorded, so the backfill does not ask again at once (t-1016).
    if (err instanceof PrivacyRefusedError) await recordRefusal(messageId);
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
  /** Refused by the privacy layer (the `local_only` policy, say): a decision, not a failure. */
  skipped: number;
}

/**
 * How long a reply the privacy layer refused to embed waits before the
 * backfill asks again (t-1016). A day, because some replies are refused by
 * design for as long as a setting stands (an agent's replies under
 * `local_only` with no local model), and each retry is refused again, logged
 * and reported to the privacy observers: once a day per reply, not once an
 * hour. Once whatever refused it changes (a local embedding model installed,
 * an agent's mode lowered), a reply is due within a day, and the backfill
 * then drains due replies at up to one batch a run, in the room fresh
 * replies leave.
 */
export const EMBEDDING_REFUSAL_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Record that the privacy layer refused to embed a reply. Any refusal: a
 * decision (the `local_only` policy, an app's policy resolver) or a fault
 * that refuses every call until it is fixed (an unreadable mode). Either
 * way, asking again on every tick would fill the backfill's batch. Best
 * effort: if the write fails, the reply is asked again next tick, as before.
 */
async function recordRefusal(messageId: string): Promise<void> {
  try {
    await prisma.aiMessage.updateMany({
      where: { id: messageId },
      data: { embeddingRefusedAt: new Date() },
    });
  } catch (err) {
    logger.warn('Failed to record a refused message embedding', {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type MissingEmbedding = { id: string; content: string; agentId: string | null };

/**
 * Assistant replies with no embedding: content over 20 characters, no
 * `ai_message_embedding` row. With the conversation's agent, so the agent's
 * privacy mode applies to the embedding as it did when the reply was first
 * queued (t-1010).
 */
const MISSING_EMBEDDINGS = Prisma.sql`
  SELECT m.id, m.content, c."agentId"
  FROM ai_message m
  LEFT JOIN ai_conversation c ON c.id = m."conversationId"
  LEFT JOIN ai_message_embedding e ON e."messageId" = m.id
  WHERE m.role = 'assistant'
    AND LENGTH(m.content) > 20
    AND e.id IS NULL`;

/**
 * Backfill embeddings for assistant messages that are missing them. Called
 * by the unified maintenance tick.
 *
 * Replies the privacy layer has never refused come first, newest first.
 * Whatever room is left goes to refused ones whose back-off
 * ({@link EMBEDDING_REFUSAL_RETRY_MS}) has passed, the longest-waiting
 * first. So refusals, whatever refused them, can never fill the batch and
 * hold back a reply behind them (t-1016). The stage alone decides what is
 * refused: nothing here copies its rules.
 */
export async function backfillMissingEmbeddings(batchSize: number = 25): Promise<BackfillResult> {
  const fresh = await prisma.$queryRaw<MissingEmbedding[]>`
    ${MISSING_EMBEDDINGS}
      AND m."embeddingRefusedAt" IS NULL
    ORDER BY m."createdAt" DESC
    LIMIT ${batchSize}
  `;
  const room = batchSize - fresh.length;
  const retries =
    room > 0
      ? await prisma.$queryRaw<MissingEmbedding[]>`
          ${MISSING_EMBEDDINGS}
            AND m."embeddingRefusedAt" < ${new Date(Date.now() - EMBEDDING_REFUSAL_RETRY_MS)}
          ORDER BY m."embeddingRefusedAt" ASC
          LIMIT ${room}
        `
      : [];
  const missing = [...fresh, ...retries];
  const retried = new Set(retries.map((m) => m.id));

  if (missing.length === 0) return { processed: 0, failed: 0, skipped: 0 };

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const scopes = new Map<string, PrivacyScope>();
  for (const msg of missing) {
    try {
      await inAgentScope(msg.agentId, () => generateAndStoreEmbedding(msg.id, msg.content), scopes);
      processed++;
    } catch (err) {
      // Refused by the privacy layer: a decision, not an embedding failure,
      // and the stage has already said why (an unreadable org slice names the
      // org and its remedy). The message stays unembedded, recorded as
      // refused, and is asked again after the back-off.
      if (err instanceof PrivacyRefusedError) {
        skipped++;
        await recordRefusal(msg.id);
        continue;
      }
      failed++;
      logger.warn('Embedding backfill failed for message', {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // A retry that fails for another reason waits its back-off again.
      // Otherwise its old time keeps it first in the retry read, and it would
      // be tried, and fail, on every run, ahead of every other due retry.
      if (retried.has(msg.id)) await recordRefusal(msg.id);
    }
  }

  if (processed > 0 || skipped > 0) {
    logger.info('Embedding backfill completed', { processed, failed, skipped });
  }

  return { processed, failed, skipped };
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
