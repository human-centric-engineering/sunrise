/**
 * Tests: Async Message Embedder
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
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
import {
  queueMessageEmbedding,
  backfillMissingEmbeddings,
} from '@/lib/orchestration/chat/message-embedder';

// ─── Fixtures ───────────────────────────────────────────────────────────

const FAKE_EMBEDDING = Array.from({ length: 1024 }, (_, i) => i * 0.001);

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(embedText).mockResolvedValue(FAKE_EMBEDDING);
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

  it('embeds and stores a valid message', async () => {
    const content = 'This is a message with enough content to embed';
    queueMessageEmbedding('msg-2', content);

    await vi.waitFor(() => {
      expect(embedText).toHaveBeenCalledWith(content, 'document');
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ai_message_embedding'),
        'msg-2',
        expect.stringContaining('[')
      );
    });
  });

  it('truncates messages longer than 8000 characters', async () => {
    const longContent = 'x'.repeat(10000);
    queueMessageEmbedding('msg-3', longContent);

    await vi.waitFor(() => {
      expect(embedText).toHaveBeenCalledWith(expect.any(String), 'document');
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
        expect.anything()
      );
    });
  });
});

describe('backfillMissingEmbeddings', () => {
  it('returns zero when no messages are missing embeddings', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

    const result = await backfillMissingEmbeddings();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('processes messages missing embeddings', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'msg-10', content: 'This is a test message that needs embedding' },
      { id: 'msg-11', content: 'Another message that also needs embedding' },
    ]);

    const result = await backfillMissingEmbeddings();

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('counts failures without stopping the batch', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'msg-10', content: 'Good message that will embed fine' },
      { id: 'msg-11', content: 'Bad message that will fail embedding' },
    ]);
    vi.mocked(prisma.$executeRawUnsafe)
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('Embedding provider down'));

    const result = await backfillMissingEmbeddings();

    expect(result).toEqual({ processed: 1, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Embedding backfill failed for message',
      expect.objectContaining({ messageId: 'msg-11' })
    );
  });

  it('returns processed=0 and does not call logger.info when all embeddings fail', async () => {
    // Arrange: two messages; both fail — processed stays 0
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'msg-30', content: 'First message that will fail to embed' },
      { id: 'msg-31', content: 'Second message that also fails to embed' },
    ]);
    vi.mocked(embedText).mockRejectedValue(new Error('Provider down'));

    // Act
    const result = await backfillMissingEmbeddings();

    // Assert: no successful embeds, both failed
    expect(result).toEqual({ processed: 0, failed: 2 });
    // logger.info must NOT be called because processed === 0
    expect(logger.info).not.toHaveBeenCalled();
    // logger.warn should have been called for each failure
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('logs stringified non-Error rejection and completed info when processed > 0', async () => {
    // Arrange: two messages; first succeeds, second fails with a plain string
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'msg-20', content: 'First message that embeds successfully now' },
      { id: 'msg-21', content: 'Second message that will fail with string error' },
    ]);
    vi.mocked(embedText)
      .mockResolvedValueOnce(FAKE_EMBEDDING) // first call succeeds
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
    });

    // Assert: return value reflects 1 processed and 1 failed
    expect(result).toEqual({ processed: 1, failed: 1 });
  });
});
