/**
 * Tests: Async Message Embedder
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
    aiMessage: { updateMany: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedText: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { logger } from '@/lib/logging';
import { PrivacyRefusedError } from '@/lib/orchestration/llm/privacy-stage';
import {
  queueMessageEmbedding,
  backfillMissingEmbeddings,
  EMBEDDING_REFUSAL_RETRY_MS,
} from '@/lib/orchestration/chat/message-embedder';

// ─── Fixtures ───────────────────────────────────────────────────────────

const FAKE_EMBEDDING = Array.from({ length: 1536 }, (_, i) => i * 0.001);
const FAKE_EMBED_RESULT = {
  embedding: FAKE_EMBEDDING,
  model: 'text-embedding-3-small',
  provider: 'openai',
  dimensions: 1536,
  inputTokens: 10,
  costUsd: 0,
};

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
  vi.mocked(embedText).mockResolvedValue(FAKE_EMBED_RESULT);
  vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1);
});

describe('queueMessageEmbedding', () => {
  it('skips messages shorter than 20 characters', async () => {
    queueMessageEmbedding('msg-1', 'short');

    // Give the async task a chance to run
    await vi.waitFor(() => {
      // embedText should NOT have been called
      expect(embedText).not.toHaveBeenCalled();
    });
  });

  it("embeds outside the turn's privacy scope, so its call is not one of the turn's (§127)", async () => {
    const { createPrivacyScope, currentPrivacyScope, runInPrivacyScope } =
      await import('@/lib/orchestration/privacy/scope');
    const seen: unknown[] = [];
    vi.mocked(embedText).mockImplementation(async () => {
      seen.push(currentPrivacyScope());
      return FAKE_EMBED_RESULT;
    });
    const turn = createPrivacyScope({ scopeId: 'conversation:c1' });

    runInPrivacyScope(turn, () =>
      queueMessageEmbedding('msg-scope', 'A long enough assistant reply to embed')
    );

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeUndefined();
  });

  it("embeds in a scope of its own carrying the reply's agent, so the agent's privacy mode applies (§127 t-1010)", async () => {
    const { createPrivacyScope, currentPrivacyScope, runInPrivacyScope } =
      await import('@/lib/orchestration/privacy/scope');
    const seen: { scope: unknown; agentId?: string; parent?: unknown; recordsNowhere?: boolean }[] =
      [];
    vi.mocked(embedText).mockImplementation(async () => {
      const s = currentPrivacyScope();
      seen.push({
        scope: s,
        agentId: s?.agentId,
        parent: s?.parent,
        recordsNowhere: s?.recordsNowhere,
      });
      return FAKE_EMBED_RESULT;
    });
    const turn = createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'agent-hr' });

    runInPrivacyScope(turn, () =>
      queueMessageEmbedding('msg-agent', 'A long enough assistant reply to embed', {
        agentId: 'agent-hr',
      })
    );

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].agentId).toBe('agent-hr');
    // Not the turn's scope, nor inside it: the turn's counts are already written.
    expect(seen[0].scope).not.toBe(turn);
    expect(seen[0].parent).toBeUndefined();
    // Nothing reads its counts, so the stage does not scan for them.
    expect(seen[0].recordsNowhere).toBe(true);
  });

  it('embeds and stores a valid message', async () => {
    const content = 'This is a message with enough content to embed';
    queueMessageEmbedding('msg-2', content);

    await vi.waitFor(() => {
      expect(embedText).toHaveBeenCalledWith(
        content,
        'document',
        expect.objectContaining({
          metadata: expect.objectContaining({ kind: 'message_embedding' }),
        })
      );
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ai_message_embedding'),
        'msg-2',
        expect.stringContaining('['),
        FAKE_EMBED_RESULT.model,
        FAKE_EMBED_RESULT.provider,
        FAKE_EMBED_RESULT.dimensions
      );
      // A raw INSERT is the one create the tenancy chokepoint cannot stamp:
      // the embedding's org is its message's, read in the same statement (§107).
      const [sql] = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0] as [string, ...unknown[]];
      expect(sql).toContain('"orgId"');
      expect(sql).toContain('(SELECT "orgId" FROM ai_message WHERE id = $1)');
    });
  });

  it('truncates messages longer than 8000 characters', async () => {
    const longContent = 'x'.repeat(10000);
    queueMessageEmbedding('msg-3', longContent);

    await vi.waitFor(() => {
      expect(embedText).toHaveBeenCalledWith(expect.any(String), 'document', expect.any(Object));
      const calledWith = vi.mocked(embedText).mock.calls[0][0];
      expect(calledWith.length).toBe(8000);
    });
  });

  it('logs a warning when embedding fails', async () => {
    vi.mocked(embedText).mockRejectedValue(new Error('Provider unavailable'));

    queueMessageEmbedding('msg-4', 'This is a valid message to embed');

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Message embedding failed',
        expect.objectContaining({
          messageId: 'msg-4',
          error: 'Provider unavailable',
        })
      );
    });
  });

  it('logs a local-only embeddings refusal at info, not as a failure (§127)', async () => {
    vi.mocked(embedText).mockRejectedValue(
      new PrivacyRefusedError('embeddings_local_only', 'openai')
    );

    queueMessageEmbedding('msg-7', 'This is a valid message to embed');

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/^Message embedding skipped: /),
        expect.objectContaining({ messageId: 'msg-7' })
      );
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still warns for a privacy refusal that is not the embeddings policy', async () => {
    vi.mocked(embedText).mockRejectedValue(new PrivacyRefusedError('stage_error', 'openai'));

    queueMessageEmbedding('msg-8', 'This is a valid message to embed');

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Message embedding failed',
        expect.objectContaining({ messageId: 'msg-8' })
      );
    });
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Message embedding skipped/),
      expect.anything()
    );
  });

  it('logs stringified non-Error rejection value via String(err)', async () => {
    // Arrange: reject with a plain string, not an Error object
    vi.mocked(embedText).mockRejectedValue('connection reset');

    // Act: queue a message long enough to trigger embedding
    queueMessageEmbedding('msg-6', 'This is a valid message to embed now');

    // Assert: logger.warn is called with String(err), not err.message
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Message embedding failed',
        expect.objectContaining({
          messageId: 'msg-6',
          error: 'connection reset',
        })
      );
    });
  });

  it('uses upsert to handle duplicate embeddings', async () => {
    queueMessageEmbedding('msg-5', 'Content that already has an embedding');

    await vi.waitFor(() => {
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });
  });
});

describe('backfillMissingEmbeddings', () => {
  it('returns zero when no messages are missing embeddings', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

    const result = await backfillMissingEmbeddings();

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 0 });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('processes messages missing embeddings', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { id: 'msg-10', content: 'This is a test message that needs embedding' },
      { id: 'msg-11', content: 'Another message that also needs embedding' },
    ]);

    const result = await backfillMissingEmbeddings();

    expect(result).toEqual({ processed: 2, failed: 0, skipped: 0 });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  describe('replies the privacy layer refuses to embed (§127 t-1010)', () => {
    it('count any privacy refusal as skipped, not failed: the stage has said why', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        {
          id: 'msg-40',
          content: 'A reply from an org whose settings cannot be read',
          agentId: null,
        },
      ]);
      vi.mocked(embedText).mockRejectedValueOnce(
        new PrivacyRefusedError('policy_resolver_failed', 'openai')
      );

      expect(await backfillMissingEmbeddings()).toEqual({ processed: 0, failed: 0, skipped: 1 });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("read an agent's settings once for the batch: one scope per agent", async () => {
      const { currentPrivacyScope } = await import('@/lib/orchestration/privacy/scope');
      const scopes: unknown[] = [];
      vi.mocked(embedText).mockImplementation(async () => {
        scopes.push(currentPrivacyScope());
        return FAKE_EMBED_RESULT;
      });
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        { id: 'msg-50', content: 'The first of two replies by one agent', agentId: 'agent-hr' },
        { id: 'msg-51', content: 'The second of two replies by one agent', agentId: 'agent-hr' },
        { id: 'msg-52', content: 'A reply by another agent altogether', agentId: 'agent-faq' },
      ]);

      await backfillMissingEmbeddings();

      expect(scopes[0]).toBe(scopes[1]);
      expect(scopes[2]).not.toBe(scopes[0]);
    });

    it('count a local-only refusal as skipped, not failed, and do not warn', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        { id: 'msg-30', content: 'A reply its agent will not let leave', agentId: 'agent-hr' },
        { id: 'msg-31', content: 'A reply that embeds without trouble', agentId: null },
      ]);
      vi.mocked(embedText)
        .mockRejectedValueOnce(new PrivacyRefusedError('embeddings_local_only', 'openai'))
        .mockResolvedValueOnce(FAKE_EMBED_RESULT);

      const result = await backfillMissingEmbeddings();

      expect(result).toEqual({ processed: 1, failed: 0, skipped: 1 });
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('replies the privacy layer refused, held back no longer (§127 t-1016)', () => {
    interface StoredReply {
      id: string;
      content: string;
      agentId: string | null;
      createdAt: Date;
      embeddingRefusedAt: Date | null;
      embedded: boolean;
    }

    /**
     * Unembedded replies, read and written through the backfill's own calls.
     * The two reads are honoured as the SQL states them: never-refused
     * replies newest first; then refused ones past the cutoff, in the
     * direction the SQL orders them; each up to its limit.
     */
    function replyStore(ids: string[]): StoredReply[] {
      const start = Date.parse('2026-11-12T09:00:00Z');
      // Oldest first: the last id is the newest reply.
      const store = ids.map((id, i) => ({
        id,
        content: `A reply long enough to be embedded (${id})`,
        agentId: 'agent-hr',
        createdAt: new Date(start + i * 1000),
        embeddingRefusedAt: null as Date | null,
        embedded: false,
      }));
      vi.mocked(prisma.$queryRaw).mockImplementation((async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const sql = strings.join('?');
        const limit = values[values.length - 1] as number;
        const missing = store.filter((m) => !m.embedded);
        const picked = sql.includes('"embeddingRefusedAt" IS NULL')
          ? missing
              .filter((m) => m.embeddingRefusedAt === null)
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          : missing
              .filter(
                (m) => m.embeddingRefusedAt !== null && m.embeddingRefusedAt < (values[1] as Date)
              )
              .sort(
                (a, b) =>
                  // In the direction the SQL orders them.
                  (sql.includes('"embeddingRefusedAt" DESC') ? -1 : 1) *
                  (a.embeddingRefusedAt!.getTime() - b.embeddingRefusedAt!.getTime())
              );
        return picked.slice(0, limit).map(({ id, content, agentId }) => ({ id, content, agentId }));
      }) as never);
      vi.mocked(prisma.aiMessage.updateMany).mockImplementation((async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { embeddingRefusedAt: Date };
      }) => {
        const reply = store.find((m) => m.id === where.id);
        if (reply) reply.embeddingRefusedAt = data.embeddingRefusedAt;
        return { count: reply ? 1 : 0 };
      }) as never);
      vi.mocked(prisma.$executeRawUnsafe).mockImplementation((async (
        _sql: string,
        messageId: string
      ) => {
        const reply = store.find((m) => m.id === messageId);
        if (reply) reply.embedded = true;
        return 1;
      }) as never);
      return store;
    }

    /**
     * Stands in for an app's policy resolver that tightens some replies'
     * agent under `local_only`: a refusal nothing in the backfill's SQL
     * knows about, and nothing there needs to.
     */
    function resolverRefuses(refused: Set<string>) {
      vi.mocked(embedText).mockImplementation(async (_text, _kind, options) => {
        const id = (options?.metadata as { messageId?: string } | undefined)?.messageId;
        if (id && refused.has(id)) throw new PrivacyRefusedError('embeddings_local_only', 'openai');
        return FAKE_EMBED_RESULT;
      });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('a batch full of refusals no longer holds back an older reply: the next run embeds it', async () => {
      const refusedIds = Array.from({ length: 25 }, (_, i) => `refused-${i}`);
      // One older reply, then 25 newer ones a resolver refuses.
      const store = replyStore(['older', ...refusedIds]);
      resolverRefuses(new Set(refusedIds));

      expect(await backfillMissingEmbeddings(25)).toEqual({ processed: 0, failed: 0, skipped: 25 });
      expect(store.filter((m) => m.embeddingRefusedAt !== null)).toHaveLength(25);

      expect(await backfillMissingEmbeddings(25)).toEqual({ processed: 1, failed: 0, skipped: 0 });
      expect(store.find((m) => m.id === 'older')?.embedded).toBe(true);
      // Not asked again inside the back-off.
      expect(vi.mocked(embedText)).toHaveBeenCalledTimes(26);
    });

    it('asks a refused reply again after the back-off, and embeds it once nothing refuses it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
      const store = replyStore(['reply']);
      const refused = new Set(['reply']);
      resolverRefuses(refused);

      expect(await backfillMissingEmbeddings()).toMatchObject({ skipped: 1 });
      vi.setSystemTime(Date.now() + EMBEDDING_REFUSAL_RETRY_MS - 1000);
      expect(await backfillMissingEmbeddings()).toEqual({ processed: 0, failed: 0, skipped: 0 });

      // A local embedding model is installed, say: nothing refuses it now.
      refused.clear();
      vi.setSystemTime(Date.now() + 2000);
      expect(await backfillMissingEmbeddings()).toEqual({ processed: 1, failed: 0, skipped: 0 });
      expect(store[0].embedded).toBe(true);
    });

    it('gives a due retry only the room fresh replies leave', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
      const store = replyStore(['retry-me']);
      const refused = new Set(['retry-me']);
      resolverRefuses(refused);
      await backfillMissingEmbeddings(2);
      refused.clear();
      vi.setSystemTime(Date.now() + EMBEDDING_REFUSAL_RETRY_MS + 1000);
      // Two fresh replies arrive, newer than the refusal.
      store.push(
        ...['fresh-1', 'fresh-2'].map((id, i) => ({
          id,
          content: `A reply long enough to be embedded (${id})`,
          agentId: null,
          createdAt: new Date(Date.now() + i),
          embeddingRefusedAt: null,
          embedded: false,
        }))
      );

      await backfillMissingEmbeddings(2);
      expect(store.filter((m) => m.embedded).map((m) => m.id)).toEqual(['fresh-1', 'fresh-2']);

      await backfillMissingEmbeddings(2);
      expect(store.find((m) => m.id === 'retry-me')?.embedded).toBe(true);
    });

    it('fills the room left with due retries, the longest waiting first, and no more', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
      // Oldest first, so the backfill reaches 'waited-longest' first.
      const store = replyStore(['waited-less', 'waited-longest']);
      const refused = new Set(['waited-less', 'waited-longest']);
      resolverRefuses(refused);
      // Refused an hour apart.
      await backfillMissingEmbeddings(1);
      vi.setSystemTime(Date.now() + EMBEDDING_REFUSAL_RETRY_MS);
      await backfillMissingEmbeddings(1);
      const at = (id: string) => store.find((m) => m.id === id)!.embeddingRefusedAt!.getTime();
      expect(at('waited-longest')).toBeLessThan(at('waited-less'));
      refused.clear();
      vi.setSystemTime(Date.now() + 2 * EMBEDDING_REFUSAL_RETRY_MS);
      store.push({
        id: 'fresh',
        content: 'A reply long enough to be embedded (fresh)',
        agentId: null,
        createdAt: new Date(Date.now()),
        embeddingRefusedAt: null,
        embedded: false,
      });

      // Room for two: the fresh reply, then one retry, the longest waiting.
      expect(await backfillMissingEmbeddings(2)).toMatchObject({ processed: 2 });
      expect(store.filter((m) => m.embedded).map((m) => m.id)).toEqual(['waited-longest', 'fresh']);
    });

    it('makes a retry that fails for another reason wait its back-off again, so the next due one gets a turn', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
      // Oldest first: 'first' is the newest, so it is refused first.
      const store = replyStore(['second', 'first']);
      resolverRefuses(new Set(['first', 'second']));
      await backfillMissingEmbeddings(1);
      vi.setSystemTime(Date.now() + 1000);
      await backfillMissingEmbeddings(1);
      const at = (id: string) => store.find((m) => m.id === id)!.embeddingRefusedAt!.getTime();
      expect(at('first')).toBeLessThan(at('second'));
      vi.setSystemTime(Date.now() + EMBEDDING_REFUSAL_RETRY_MS + 1000);
      // Nothing refuses them now, but 'first', the longest waiting, fails for
      // another reason, and the run has room for one.
      vi.mocked(embedText).mockImplementation(async (_text, _kind, options) => {
        const id = (options?.metadata as { messageId?: string } | undefined)?.messageId;
        if (id === 'first') throw new Error('input too long for the local model');
        return FAKE_EMBED_RESULT;
      });

      expect(await backfillMissingEmbeddings(1)).toEqual({ processed: 0, failed: 1, skipped: 0 });
      // Its time moved to now, so the other due retry is next, not it again.
      expect(at('first')).toBe(Date.now());
      expect(await backfillMissingEmbeddings(1)).toEqual({ processed: 1, failed: 0, skipped: 0 });
      expect(store.find((m) => m.id === 'second')?.embedded).toBe(true);
    });

    it('reads only assistant replies of some length that have no embedding', async () => {
      // The store does this filtering itself, so the SQL's own is pinned here:
      // without it the backfill would re-embed every message, user ones too.
      await backfillMissingEmbeddings();
      const fragment = vi.mocked(prisma.$queryRaw).mock.calls[0][1] as { sql: string };
      expect(fragment.sql).toMatch(/m\.role = 'assistant'/);
      expect(fragment.sql).toMatch(/LENGTH\(m\.content\) > 20/);
      expect(fragment.sql).toMatch(/LEFT JOIN ai_message_embedding e ON e\."messageId" = m\.id/);
      expect(fragment.sql).toMatch(/e\.id IS NULL/);
    });

    it('records a refusal on the live path too, so the backfill does not ask again at once', async () => {
      vi.mocked(embedText).mockRejectedValueOnce(
        new PrivacyRefusedError('embeddings_local_only', 'openai')
      );

      queueMessageEmbedding('msg-live', 'A reply the privacy layer will not embed now', {
        agentId: 'agent-hr',
      });
      await vi.waitFor(() => expect(prisma.aiMessage.updateMany).toHaveBeenCalled());

      expect(prisma.aiMessage.updateMany).toHaveBeenCalledWith({
        where: { id: 'msg-live' },
        data: { embeddingRefusedAt: expect.any(Date) },
      });
    });

    it('does not record an embedding failure that is not a refusal: it is asked again next run', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        { id: 'msg-60', content: 'A reply whose provider timed out', agentId: null },
      ]);
      vi.mocked(embedText).mockRejectedValueOnce(new Error('timeout'));

      expect(await backfillMissingEmbeddings()).toEqual({ processed: 0, failed: 1, skipped: 0 });
      expect(prisma.aiMessage.updateMany).not.toHaveBeenCalled();
    });

    it('warns, and goes on, when recording a refusal fails', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        { id: 'msg-70', content: 'A reply refused while the database blinked', agentId: null },
      ]);
      vi.mocked(embedText).mockRejectedValueOnce(
        new PrivacyRefusedError('embeddings_local_only', 'openai')
      );
      vi.mocked(prisma.aiMessage.updateMany).mockRejectedValueOnce(new Error('connection reset'));

      expect(await backfillMissingEmbeddings()).toEqual({ processed: 0, failed: 0, skipped: 1 });
      expect(logger.warn).toHaveBeenCalledWith('Failed to record a refused message embedding', {
        messageId: 'msg-70',
        error: 'connection reset',
      });
    });
  });

  it("embeds each message in a scope carrying its conversation's agent (§127 t-1010)", async () => {
    const { currentPrivacyScope } = await import('@/lib/orchestration/privacy/scope');
    const agents: (string | undefined)[] = [];
    vi.mocked(embedText).mockImplementation(async () => {
      agents.push(currentPrivacyScope()?.agentId);
      return FAKE_EMBED_RESULT;
    });
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { id: 'msg-20', content: 'An HR reply that needs its embedding', agentId: 'agent-hr' },
      { id: 'msg-21', content: 'A reply whose conversation is gone now', agentId: null },
    ]);

    await backfillMissingEmbeddings();

    // A refused embedding leaves its message without a row; without the
    // agent here, the next tick would send what the agent's mode refused.
    expect(agents).toEqual(['agent-hr', undefined]);
  });

  it('counts failures without stopping the batch', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { id: 'msg-10', content: 'Good message that will embed fine' },
      { id: 'msg-11', content: 'Bad message that will fail embedding' },
    ]);
    vi.mocked(prisma.$executeRawUnsafe)
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('Embedding provider down'));

    const result = await backfillMissingEmbeddings();

    expect(result).toEqual({ processed: 1, failed: 1, skipped: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Embedding backfill failed for message',
      expect.objectContaining({ messageId: 'msg-11' })
    );
  });

  it('returns processed=0 and does not call logger.info when all embeddings fail', async () => {
    // Arrange: two messages; both fail — processed stays 0
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { id: 'msg-30', content: 'First message that will fail to embed' },
      { id: 'msg-31', content: 'Second message that also fails to embed' },
    ]);
    vi.mocked(embedText).mockRejectedValue(new Error('Provider down'));

    // Act
    const result = await backfillMissingEmbeddings();

    // Assert: no successful embeds, both failed
    expect(result).toEqual({ processed: 0, failed: 2, skipped: 0 });
    // logger.info must NOT be called because processed === 0
    expect(logger.info).not.toHaveBeenCalled();
    // logger.warn should have been called for each failure
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('logs stringified non-Error rejection and completed info when processed > 0', async () => {
    // Arrange: two messages; first succeeds, second fails with a plain string
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { id: 'msg-20', content: 'First message that embeds successfully now' },
      { id: 'msg-21', content: 'Second message that will fail with string error' },
    ]);
    vi.mocked(embedText)
      .mockResolvedValueOnce(FAKE_EMBED_RESULT) // first call succeeds
      .mockRejectedValueOnce('timeout'); // second call rejects with non-Error string

    // Act
    const result = await backfillMissingEmbeddings();

    // Assert: non-Error rejection is stringified via String(err)
    expect(logger.warn).toHaveBeenCalledWith(
      'Embedding backfill failed for message',
      expect.objectContaining({
        messageId: 'msg-21',
        error: 'timeout',
      })
    );

    // Assert: completed info is logged because processed (1) > 0
    expect(logger.info).toHaveBeenCalledWith('Embedding backfill completed', {
      processed: 1,
      failed: 1,
      skipped: 0,
    });

    // Assert: return value reflects 1 processed and 1 failed
    expect(result).toEqual({ processed: 1, failed: 1, skipped: 0 });
  });

  describe('cost attribution (#654)', () => {
    it('bills the embedding to the conversation and agent when the caller has them', async () => {
      // /code-review round 3: the last chat-path embedding sink still landing
      // with all three FK columns null, while its only production call site had
      // both real ids in scope.
      // >= 20 chars, or `queueMessageEmbedding` returns before doing anything.
      const content = 'A message long enough to be worth embedding.';
      queueMessageEmbedding('msg-1', content, {
        agentId: 'agent-real',
        conversationId: 'conv-real',
      });
      await vi.waitFor(() => expect(embedText).toHaveBeenCalled());

      expect(embedText).toHaveBeenCalledWith(
        content,
        'document',
        expect.objectContaining({ agentId: 'agent-real', conversationId: 'conv-real' })
      );
    });

    it('omits the FK columns when the caller has no ids, rather than inventing them', async () => {
      // The backfill path has neither in scope. Absent is the other safe value;
      // a placeholder would be rejected exactly as `'system'` was.
      queueMessageEmbedding('msg-2', 'A message long enough to be worth embedding.');
      await vi.waitFor(() => expect(embedText).toHaveBeenCalled());

      const attribution = vi.mocked(embedText).mock.calls[0][2] as Record<string, unknown>;
      expect(attribution).not.toHaveProperty('agentId');
      expect(attribution).not.toHaveProperty('conversationId');
    });
  });
});
