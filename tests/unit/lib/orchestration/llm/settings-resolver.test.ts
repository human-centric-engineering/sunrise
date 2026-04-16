/**
 * Unit Tests: lib/orchestration/llm/settings-resolver
 *
 * Test Coverage:
 * - getDefaultModelForTask: returns computed default when no DB row exists
 * - getDefaultModelForTask: returns stored value from DB row when present
 * - getDefaultModelForTask: falls back to computed default for missing task keys
 * - getDefaultModelForTask: caches result and avoids second DB read within TTL
 * - getDefaultModelForTask: re-fetches from DB after cache is invalidated
 * - getDefaultModelForTask: re-fetches after TTL expires (fake timers)
 * - getDefaultModelForTask: uses computed defaults and warns when DB read fails
 * - invalidateSettingsCache: clears the cache so next call re-reads DB
 * - __resetSettingsResolverForTests: exposed helper clears state between tests
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

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  computeDefaultModelMap: vi.fn(() => ({
    routing: 'computed-routing-model',
    chat: 'computed-chat-model',
    reasoning: 'computed-reasoning-model',
    embeddings: 'computed-embeddings-model',
  })),
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
  getDefaultModelForTask,
  invalidateSettingsCache,
  __resetSettingsResolverForTests,
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

describe('getDefaultModelForTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Always start with a clean cache so tests are independent
    __resetSettingsResolverForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetSettingsResolverForTests();
  });

  describe('DB row absent', () => {
    it('returns the computed default when no settings row exists', async () => {
      // Arrange: DB returns null (no row yet)
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      // Act
      const result = await getDefaultModelForTask('chat');

      // Assert
      expect(result).toBe('computed-chat-model');
    });

    it('returns computed defaults for all task types when row is absent', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      expect(await getDefaultModelForTask('routing')).toBe('computed-routing-model');
      // Cache is populated now — reset so each fresh call hits DB once per task
      // (in this test we care only that each task gets its computed default)
      expect(await getDefaultModelForTask('reasoning')).toBe('computed-reasoning-model');
    });
  });

  describe('DB row present', () => {
    it('returns the stored model when the settings row has a value for the task', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({ chat: 'stored-chat-model' }) as never
      );

      const result = await getDefaultModelForTask('chat');

      expect(result).toBe('stored-chat-model');
    });

    it('falls back to computed default for tasks not present in the stored map', async () => {
      // Only 'chat' is stored; routing/reasoning/embeddings must fall back
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({ chat: 'stored-chat-model' }) as never
      );

      const result = await getDefaultModelForTask('routing');

      expect(result).toBe('computed-routing-model');
    });

    it('falls back to computed default when stored value is an empty string', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettingsRow({ chat: '' }) as never
      );

      const result = await getDefaultModelForTask('chat');

      expect(result).toBe('computed-chat-model');
    });

    it('calls prisma.aiOrchestrationSettings.findUnique with slug "global"', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      await getDefaultModelForTask('chat');

      expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledWith({
        where: { slug: 'global' },
      });
    });
  });

  describe('caching behaviour', () => {
    it('only calls the DB once for multiple calls within the TTL', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      await getDefaultModelForTask('chat');
      await getDefaultModelForTask('routing');
      await getDefaultModelForTask('reasoning');

      // All three calls should share one DB lookup
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

    it('re-fetches from DB after cache is invalidated by invalidateSettingsCache()', async () => {
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
      // Advance past the 30s TTL
      vi.advanceTimersByTime(31_000);
      const after = await getDefaultModelForTask('chat');

      expect(before).toBe('model-before-ttl');
      expect(after).toBe('model-after-ttl');
      expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('uses computed defaults and logs a warning when DB read throws', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
        new Error('Connection refused')
      );

      const result = await getDefaultModelForTask('chat');

      // Should still return a valid model using computed defaults
      expect(result).toBe('computed-chat-model');
    });

    it('calls logger.warn when the DB read fails', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
        new Error('DB timeout')
      );

      await getDefaultModelForTask('chat');

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('getDefaultModelForTask'),
        expect.objectContaining({ error: 'DB timeout' })
      );
    });

    it('still caches the computed-default result after a DB error', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
        new Error('DB timeout')
      );

      await getDefaultModelForTask('chat');
      await getDefaultModelForTask('routing');

      // Even with an error the result is cached — only one DB attempt
      expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(1);
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
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

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
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    await getDefaultModelForTask('chat');
    __resetSettingsResolverForTests();
    await getDefaultModelForTask('chat');

    expect(prisma.aiOrchestrationSettings.findUnique).toHaveBeenCalledTimes(2);
  });
});
