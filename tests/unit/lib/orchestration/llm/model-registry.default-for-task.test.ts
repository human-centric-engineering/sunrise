/**
 * Unit tests for getDefaultModelForTask, validateTaskDefaults, and invalidateSettingsCache
 * in model-registry.ts
 *
 * Test Coverage:
 * - First call upserts via prisma.aiOrchestrationSettings.findUnique, returns stored model
 * - Second call within TTL hits the cache (findUnique called once total)
 * - invalidateSettingsCache() forces a re-read on next call
 * - validateTaskDefaults({ chat: 'not-a-real-model' }) returns an error
 * - validateTaskDefaults({ chat: 'claude-sonnet-4-6' }) returns empty array
 *
 * @see lib/orchestration/llm/model-registry.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const registry = await import('@/lib/orchestration/llm/model-registry');
const resolver = await import('@/lib/orchestration/llm/settings-resolver');

const mockedFindUnique = prisma.aiOrchestrationSettings.findUnique as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset registry state (model fallback map) and the resolver's settings cache
  registry.__resetForTests();
  resolver.__resetSettingsResolverForTests();
});

describe('getDefaultModelForTask', () => {
  describe('first call — reads from DB and caches result', () => {
    it('returns the stored model for a task when settings row exists', async () => {
      // Arrange
      mockedFindUnique.mockResolvedValueOnce({
        defaultModels: {
          routing: 'claude-haiku-4-5',
          chat: 'claude-opus-4-6',
          reasoning: 'claude-opus-4-6',
          embeddings: 'claude-haiku-4-5',
        },
      });

      // Act
      const model = await resolver.getDefaultModelForTask('routing');

      // Assert
      expect(model).toBe('claude-haiku-4-5');
      expect(mockedFindUnique).toHaveBeenCalledOnce();
      expect(mockedFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: 'global' } })
      );
    });

    it('falls back to computed defaults for tasks missing from stored map', async () => {
      // Arrange: stored map only has 'chat', other tasks should fall back
      mockedFindUnique.mockResolvedValueOnce({
        defaultModels: { chat: 'claude-sonnet-4-6' },
      });

      // Act: request a task that is NOT in the stored map
      const model = await resolver.getDefaultModelForTask('routing');

      // Assert: gets a non-empty string from computeDefaultModelMap
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
    });

    it('returns computed defaults when settings row is null', async () => {
      // Arrange
      mockedFindUnique.mockResolvedValueOnce(null);

      // Act
      const model = await resolver.getDefaultModelForTask('chat');

      // Assert: computed defaults still work
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
    });
  });

  describe('second call within TTL — uses cache', () => {
    it('calls prisma findUnique only once for two consecutive calls within TTL', async () => {
      // Arrange
      mockedFindUnique.mockResolvedValue({
        defaultModels: {
          routing: 'claude-haiku-4-5',
          chat: 'claude-haiku-4-5',
          reasoning: 'claude-opus-4-6',
          embeddings: 'claude-haiku-4-5',
        },
      });

      // Act: two calls to different tasks
      const first = await resolver.getDefaultModelForTask('routing');
      const second = await resolver.getDefaultModelForTask('chat');

      // Assert: DB only queried once (cache hit on second call)
      expect(mockedFindUnique).toHaveBeenCalledOnce();
      expect(first).toBe('claude-haiku-4-5');
      expect(second).toBe('claude-haiku-4-5');
    });
  });

  describe('invalidateSettingsCache — forces re-read on next call', () => {
    it('after invalidation, the next call reads from DB again', async () => {
      // Arrange: first call populates cache
      mockedFindUnique.mockResolvedValue({
        defaultModels: {
          routing: 'claude-haiku-4-5',
          chat: 'claude-haiku-4-5',
          reasoning: 'claude-opus-4-6',
          embeddings: 'claude-haiku-4-5',
        },
      });

      // First call — caches
      await resolver.getDefaultModelForTask('routing');
      expect(mockedFindUnique).toHaveBeenCalledTimes(1);

      // Invalidate cache
      resolver.invalidateSettingsCache();

      // Second call — should re-read DB
      await resolver.getDefaultModelForTask('chat');
      expect(mockedFindUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('DB failure — graceful fallback', () => {
    it('returns computed defaults when DB lookup throws', async () => {
      // Arrange
      mockedFindUnique.mockRejectedValueOnce(new Error('DB connection timeout'));

      // Act
      let thrown = false;
      let model;
      try {
        model = await resolver.getDefaultModelForTask('reasoning');
      } catch {
        thrown = true;
      }

      // Assert: never throws, returns a computed default
      expect(thrown).toBe(false);
      expect(typeof model).toBe('string');
      expect((model as string).length).toBeGreaterThan(0);
    });
  });
});

describe('validateTaskDefaults', () => {
  it('returns an error for an unknown model id', () => {
    // Arrange + Act
    const errors = registry.validateTaskDefaults({ chat: 'not-a-real-model' });

    // Assert
    expect(errors).toHaveLength(1);
    expect(errors[0].task).toBe('chat');
    expect(errors[0].message).toMatch(/unknown model/i);
  });

  it('returns an empty array for a known valid model id', () => {
    // Arrange + Act
    const errors = registry.validateTaskDefaults({ chat: 'claude-sonnet-4-6' });

    // Assert: claude-sonnet-4-6 is in the fallback map
    expect(errors).toHaveLength(0);
  });

  it('returns errors for multiple invalid model ids', () => {
    // Arrange + Act
    const errors = registry.validateTaskDefaults({
      chat: 'bad-model-1',
      routing: 'bad-model-2',
    });

    // Assert: one error per invalid task
    expect(errors).toHaveLength(2);
    const tasks = errors.map((e) => e.task);
    expect(tasks).toContain('chat');
    expect(tasks).toContain('routing');
  });

  it('ignores tasks not included in the partial map', () => {
    // Arrange + Act: only 'chat' provided — routing/reasoning/embeddings are not validated
    const errors = registry.validateTaskDefaults({ chat: 'claude-haiku-4-5' });

    // Assert: no errors
    expect(errors).toHaveLength(0);
  });

  it('returns an error for an empty-string model id', () => {
    // Arrange + Act
    const errors = registry.validateTaskDefaults({ chat: '' });

    // Assert
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/non-empty/i);
  });
});
