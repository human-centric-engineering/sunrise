/**
 * Unit Tests: lib/orchestration/llm/settings-resolver
 *
 * Test Coverage (strict mode):
 * - getDefaultModelForTask: returns the stored model when present
 * - getDefaultModelForTask: throws NoDefaultModelConfiguredError when stored slot is empty
 * - getDefaultModelForTask: throws when DB row is absent
 * - getDefaultModelForTask: throws when stored value is the empty string
 * - getDefaultModelForTaskOrNull: same logic but returns null instead of throwing
 * - caching: only hits the DB once per TTL window
 * - caching: re-fetches after invalidateSettingsCache()
 * - caching: re-fetches after the 30-second TTL expires
 * - error handling: DB failure throws on next read (no silent fallback)
 *
 * The strict-mode change means the resolver no longer hides "operator
 * hasn't configured a default" behind a registry-derived fallback.
 *
 * @see lib/orchestration/llm/settings-resolver.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  NoDefaultModelConfiguredError,
  __resetSettingsResolverForTests,
  getDefaultModelForTask,
  getDefaultModelForTaskOrNull,
  invalidateSettingsCache,
} from '@/lib/orchestration/llm/settings-resolver';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSettingsRow(defaultModels: Record<string, string> = {}) {
  return {
    id: 'settings-1',
    slug: 'global',
    defaultModels,
    globalMonthlyBudgetUsd: null,
    createdAt: new Date('2026-04-15T00:00:00Z'),
    updatedAt: new Date('2026-04-15T00:00:00Z'),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getDefaultModelForTask (strict)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSettingsResolverForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetSettingsResolverForTests();
  });

  describe('returns stored value when present', () => {
    it('returns the stored model when the settings row has a value for the task', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({ chat: 'stored-chat-model' }) as never
      );

      const result = await getDefaultModelForTask('chat');

      expect(result).toBe('stored-chat-model');
    });

    it('returns the stored model for each task type independently', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({
          routing: 'stored-routing',
          chat: 'stored-chat',
          reasoning: 'stored-reasoning',
          embeddings: 'stored-embeddings',
        }) as never
      );

      expect(await getDefaultModelForTask('routing')).toBe('stored-routing');
      expect(await getDefaultModelForTask('chat')).toBe('stored-chat');
      expect(await getDefaultModelForTask('reasoning')).toBe('stored-reasoning');
      expect(await getDefaultModelForTask('embeddings')).toBe('stored-embeddings');
    });
  });

  describe('strict mode: throws when slot is unset', () => {
    it('throws NoDefaultModelConfiguredError when the DB row is absent', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      await expect(getDefaultModelForTask('chat')).rejects.toBeInstanceOf(
        NoDefaultModelConfiguredError
      );
    });

    it('throws when only the requested task slot is missing from the stored map', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        // chat is present, routing is not
        makeSettingsRow({ chat: 'stored-chat' }) as never
      );

      await expect(getDefaultModelForTask('routing')).rejects.toBeInstanceOf(
        NoDefaultModelConfiguredError
      );
      // Chat slot still resolves cleanly.
      expect(await getDefaultModelForTask('chat')).toBe('stored-chat');
    });

    it('throws when the stored value is the empty string', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({ chat: '' }) as never
      );

      await expect(getDefaultModelForTask('chat')).rejects.toBeInstanceOf(
        NoDefaultModelConfiguredError
      );
    });

    it('preserves the task name on the thrown error so callers can log it', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      try {
        await getDefaultModelForTask('embeddings');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(NoDefaultModelConfiguredError);
        if (err instanceof NoDefaultModelConfiguredError) {
          expect(err.task).toBe('embeddings');
          expect(err.code).toBe('no_default_model_configured');
        }
      }
    });
  });

  describe('getDefaultModelForTaskOrNull', () => {
    it('returns the stored value when present', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({ chat: 'stored-chat' }) as never
      );

      expect(await getDefaultModelForTaskOrNull('chat')).toBe('stored-chat');
    });

    it('returns null when the slot is unset (instead of throwing)', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      expect(await getDefaultModelForTaskOrNull('chat')).toBeNull();
    });
  });

  describe('caching behaviour', () => {
    it('only calls the DB once for multiple calls within the TTL', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({
          routing: 'r',
          chat: 'c',
          reasoning: 'rs',
          embeddings: 'e',
        }) as never
      );

      await getDefaultModelForTask('chat');
      await getDefaultModelForTask('routing');
      await getDefaultModelForTask('reasoning');

      expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(1);
    });

    it('returns the cached value on the second call', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({ chat: 'cached-model' }) as never
      );

      const first = await getDefaultModelForTask('chat');
      const second = await getDefaultModelForTask('chat');

      expect(first).toBe('cached-model');
      expect(second).toBe('cached-model');
    });

    it('re-fetches from DB after invalidateSettingsCache()', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique)
        .mockResolvedValueOnce(makeSettingsRow({ chat: 'first-model' }) as never)
        .mockResolvedValueOnce(makeSettingsRow({ chat: 'second-model' }) as never);

      const first = await getDefaultModelForTask('chat');
      invalidateSettingsCache();
      const second = await getDefaultModelForTask('chat');

      expect(first).toBe('first-model');
      expect(second).toBe('second-model');
      expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(2);
    });

    it('re-fetches after the 30-second TTL expires', async () => {
      vi.useFakeTimers();
      vi.mocked(prisma.aiOrchestrationSettings.findUnique)
        .mockResolvedValueOnce(makeSettingsRow({ chat: 'model-before-ttl' }) as never)
        .mockResolvedValueOnce(makeSettingsRow({ chat: 'model-after-ttl' }) as never);

      const before = await getDefaultModelForTask('chat');
      vi.advanceTimersByTime(31_000);
      const after = await getDefaultModelForTask('chat');

      expect(before).toBe('model-before-ttl');
      expect(after).toBe('model-after-ttl');
      expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(2);
    });

    it('caches the empty-stored state too — repeated calls keep throwing without a second DB hit', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      await expect(getDefaultModelForTask('chat')).rejects.toBeInstanceOf(
        NoDefaultModelConfiguredError
      );
      await expect(getDefaultModelForTask('chat')).rejects.toBeInstanceOf(
        NoDefaultModelConfiguredError
      );

      expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('throws on next read after a DB failure (no silent fallback)', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
        new Error('Connection refused')
      );

      // Strict mode: a DB failure leaves the cache "empty stored" and
      // the next read throws NoDefaultModelConfiguredError. The
      // operator never receives a silently-picked model.
      await expect(getDefaultModelForTask('chat')).rejects.toBeInstanceOf(
        NoDefaultModelConfiguredError
      );
    });

    it('logs a warning when the DB read fails', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
        new Error('DB timeout')
      );

      await getDefaultModelForTask('chat').catch(() => {});

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('getDefaultModelForTask'),
        expect.objectContaining({ error: 'DB timeout' })
      );
    });
  });
});

describe('invalidateSettingsCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSettingsResolverForTests();
  });

  afterEach(() => {
    __resetSettingsResolverForTests();
  });

  it('causes the next getDefaultModelForTask call to re-read from DB', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettingsRow({ chat: 'cached' }) as never
    );

    await getDefaultModelForTask('chat');
    expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(1);

    invalidateSettingsCache();

    await getDefaultModelForTask('chat');
    expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('__resetSettingsResolverForTests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    __resetSettingsResolverForTests();
  });

  it('is exported and can be called without error', () => {
    expect(() => __resetSettingsResolverForTests()).not.toThrow();
  });

  it('clears the cache so the next call hits the DB again', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettingsRow({ chat: 'cached' }) as never
    );

    await getDefaultModelForTask('chat');
    __resetSettingsResolverForTests();
    await getDefaultModelForTask('chat');

    expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(2);
  });
});
