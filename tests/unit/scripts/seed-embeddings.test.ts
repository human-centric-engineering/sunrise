/**
 * Tests for `scripts/seed-embeddings.ts` (`npm run db:seed:embeddings`).
 *
 * The script's top-level `main()` fires at import time, so each test mocks
 * the dependencies and dynamically imports it. What matters is the org it
 * runs in: the patterns knowledge is the install org's (§116 t-733), and at
 * `TENANCY_MODE=multi` a query with no org fails, so it must enter the
 * install org rather than run with no context.
 *
 * @see scripts/seed-embeddings.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEmbedChunks = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
/** The org `embedChunks` was called in, read from the real tenant context. */
const seenOrg = vi.hoisted(() => ({ orgId: undefined as string | null | undefined }));

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

vi.mock('@/lib/orchestration/knowledge/seeder', async () => {
  const { getTenantContext } = await import('@/lib/tenancy/context');
  return {
    embedChunks: (...args: unknown[]) => {
      seenOrg.orgId = getTenantContext()?.orgId;
      return mockEmbedChunks(...args);
    },
  };
});

vi.mock('@/lib/logging', () => ({
  logger: { info: mockLoggerInfo, error: mockLoggerError, debug: vi.fn(), warn: vi.fn() },
}));

async function runScript(): Promise<void> {
  await import('@/scripts/seed-embeddings');
  // Let main()'s promise, and its catch, settle.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe('scripts/seed-embeddings', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    seenOrg.orgId = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('embeds inside the install org', async () => {
    mockEmbedChunks.mockResolvedValue({ processed: 3, total: 191, alreadyEmbedded: 188 });

    await runScript();

    expect(mockEmbedChunks).toHaveBeenCalledTimes(1);
    // Run with no context instead, this is undefined, and at `multi` the
    // chokepoint refuses the query.
    expect(seenOrg.orgId).toBe('install');
    expect(mockLoggerInfo).toHaveBeenCalledWith('✅ Embeddings complete', {
      processed: 3,
      total: 191,
      alreadyEmbedded: 188,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs a failure and exits 1', async () => {
    const failure = new Error('no embedding provider');
    mockEmbedChunks.mockRejectedValue(failure);

    await runScript();

    expect(mockLoggerError).toHaveBeenCalledWith('❌ Embedding run failed', failure);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
