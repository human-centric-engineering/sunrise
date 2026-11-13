/**
 * Async Message Embedder
 *
 * After each assistant message is persisted, queues an async embedding
 * job to generate and store a vector embedding for semantic search.
 * Non-blocking to the chat stream — failures are logged but do not
 * affect the user experience. A reply whose embedding fails, or that the LLM
 * privacy layer refuses to embed (its `local_only` embeddings policy with no
 * local model, say), is given a retry time, and the backfill asks again only
 * then, each failure doubling the wait (§127 t-1016).
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
    // Failed or refused: the backfill waits before asking again (t-1016). The
    // first attempt, so no earlier failures.
    await deferEmbedding(messageId, 0);
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
  /**
   * Whether the run tried a full batch, so more may be waiting behind it.
   * A run that did not has left nothing behind: every reply it failed waits
   * for its retry time (t-1016).
   */
  filledBatch: boolean;
}

/**
 * The wait after a reply's first failed or refused embedding (t-1016): one
 * backfill interval, so a one-off error (a provider's rate limit) is picked
 * up by the next run, as it was before any failure was backed off.
 */
export const EMBEDDING_RETRY_BASE_MS = 15 * 60 * 1000;

/** The longest wait between attempts, however many have failed. */
export const EMBEDDING_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long to wait after the `failures`-th failed or refused attempt in a
 * row: 15 minutes, doubling each time, at most a week from the eleventh
 * failure on (owner rulings: back off everything, 2026-11-12; first wait one
 * backfill interval, 2026-11-13). A reply that can never be embedded, say an
 * agent's reply under `local_only` with no local model, settles to one
 * attempt a week, so an install where nothing can be embedded does little:
 * at a week's wait and a batch of 25 a quarter-hour, up to about 16,800 such
 * replies per org fit, and only a backlog larger than that keeps every run
 * busy. One that is fixed is tried again within its current wait.
 */
export function embeddingRetryDelayMs(failures: number): number {
  return Math.min(EMBEDDING_RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0), EMBEDDING_RETRY_MAX_MS);
}

/**
 * Give a reply whose embedding failed or was refused a time to try again,
 * after `previous` failures in a row. Any failure: a privacy refusal (the
 * `local_only` policy, an app's policy resolver, an unreadable mode), a
 * provider refusal (an org's provider policy), or an error (a local model
 * rejecting a long reply). Asking again on every run would let 25 of them
 * fill the backfill's batch for good. Best effort: if the write fails, the
 * reply is asked again next run, as before t-1016.
 */
async function deferEmbedding(messageId: string, previous: number): Promise<void> {
  const failures = previous + 1;
  try {
    await prisma.aiMessage.updateMany({
      where: { id: messageId },
      data: {
        embeddingFailures: failures,
        embeddingRetryAt: new Date(Date.now() + embeddingRetryDelayMs(failures)),
      },
    });
  } catch (err) {
    logger.warn('Failed to defer a message embedding', {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Forget a reply's failed attempts once it is embedded. Best effort. */
async function clearDeferral(messageId: string): Promise<void> {
  try {
    await prisma.aiMessage.updateMany({
      where: { id: messageId },
      data: { embeddingFailures: 0, embeddingRetryAt: null },
    });
  } catch (err) {
    logger.warn('Failed to clear a message embedding deferral', {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type MissingEmbedding = {
  id: string;
  content: string;
  agentId: string | null;
  embeddingFailures: number;
};

/**
 * Assistant replies with no embedding: content over 20 characters, no
 * `ai_message_embedding` row. With the conversation's agent, so the agent's
 * privacy mode applies to the embedding as it did when the reply was first
 * queued (t-1010).
 */
const MISSING_EMBEDDINGS = Prisma.sql`
  SELECT m.id, m.content, c."agentId", m."embeddingFailures"
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
 * Replies that never failed come first, newest first. Whatever room is left
 * goes to failed ones whose retry time has come, the earliest first
 * ({@link embeddingRetryDelayMs}). So no failure, whatever caused it, can
 * fill the batch and hold back a reply behind it (t-1016). The privacy stage
 * alone decides what is refused: nothing here copies its rules.
 */
export async function backfillMissingEmbeddings(batchSize: number = 25): Promise<BackfillResult> {
  const fresh = await prisma.$queryRaw<MissingEmbedding[]>`
    ${MISSING_EMBEDDINGS}
      AND m."embeddingRetryAt" IS NULL
    ORDER BY m."createdAt" DESC
    LIMIT ${batchSize}
  `;
  const room = batchSize - fresh.length;
  const due =
    room > 0
      ? await prisma.$queryRaw<MissingEmbedding[]>`
          ${MISSING_EMBEDDINGS}
            AND m."embeddingRetryAt" <= ${new Date()}
          ORDER BY m."embeddingRetryAt" ASC
          LIMIT ${room}
        `
      : [];
  const missing = [...fresh, ...due];

  if (missing.length === 0) return { processed: 0, failed: 0, skipped: 0, filledBatch: false };

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const scopes = new Map<string, PrivacyScope>();
  for (const msg of missing) {
    try {
      await inAgentScope(msg.agentId, () => generateAndStoreEmbedding(msg.id, msg.content), scopes);
      processed++;
      // Embedded after failing: its count starts again, so a later failure
      // (once `embeddings:reset` drops the embedding, say) waits 15 minutes, not
      // the week its old count would give it.
      if (msg.embeddingFailures > 0) await clearDeferral(msg.id);
    } catch (err) {
      // Either way it waits before the next attempt, longer each time.
      await deferEmbedding(msg.id, msg.embeddingFailures);
      // Refused by the privacy layer: a decision, not an embedding failure,
      // and the stage has already said why (an unreadable org slice names the
      // org and its remedy).
      if (err instanceof PrivacyRefusedError) {
        skipped++;
        continue;
      }
      failed++;
      logger.warn('Embedding backfill failed for message', {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (processed > 0 || skipped > 0) {
    logger.info('Embedding backfill completed', { processed, failed, skipped });
  }

  return { processed, failed, skipped, filledBatch: missing.length >= batchSize };
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
