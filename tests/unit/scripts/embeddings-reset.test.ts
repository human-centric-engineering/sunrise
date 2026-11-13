/**
 * Tests for `scripts/embeddings-reset.ts` (`npm run embeddings:reset`).
 *
 * The script's top-level `main()` fires at import time, so each test mocks
 * the dependencies and dynamically imports it. What matters: the destructive
 * steps run in an order the database accepts, at the active model's
 * dimension; every reply's embedding retry time and count are cleared, so
 * none waits out a back-off earned under the old model (§127 t-1016); and a
 * refusal at the prompt changes nothing.
 *
 * @see scripts/embeddings-reset.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecute = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockActiveModel = vi.fn();
const mockAnswer = vi.fn();

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeChunk: { count: vi.fn(async () => 3) },
    aiKnowledgeDocument: { count: vi.fn(async () => 1) },
    aiMessageEmbedding: { count: vi.fn(async () => 7) },
    $executeRawUnsafe: (...args: unknown[]) => mockExecute(...args),
    $disconnect: vi.fn(async () => undefined),
  },
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  getActiveEmbeddingModelSummary: () => mockActiveModel(),
}));

vi.mock('readline/promises', () => ({
  createInterface: () => ({ question: () => mockAnswer(), close: vi.fn() }),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: mockLoggerInfo, error: mockLoggerError, debug: vi.fn(), warn: vi.fn() },
}));

async function runScript(): Promise<void> {
  await import('@/scripts/embeddings-reset');
  // Let main()'s promise, and its catch, settle.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Each statement the script sent, in order. */
const statements = (): string[] => mockExecute.mock.calls.map((call) => String(call[0]));

describe('scripts/embeddings-reset', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const argv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExecute.mockResolvedValue(0);
    mockActiveModel.mockResolvedValue({ modelId: 'voyage-3', dimensions: 1024 });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.argv = argv;
  });

  it('with --yes: truncates, clears every reply’s retry time, then rebuilds at the active dimension', async () => {
    process.argv = [...argv, '--yes'];

    await runScript();

    const sent = statements();
    const at = (pattern: RegExp) => sent.findIndex((s) => pattern.test(s));
    const truncate = at(
      /^TRUNCATE TABLE "ai_knowledge_chunk", "ai_knowledge_document", "ai_message_embedding"/
    );
    const clear = at(/^UPDATE "ai_message" SET "embeddingRetryAt" = NULL, "embeddingFailures" = 0/);
    const rebuild = at(/ADD COLUMN "embedding" vector\(1024\) NOT NULL/);
    expect(truncate).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(truncate);
    expect(rebuild).toBeGreaterThan(clear);
    // Only the rows that have one: a reply that never failed is left alone.
    expect(sent[clear]).toMatch(
      /WHERE "embeddingRetryAt" IS NOT NULL OR "embeddingFailures" <> 0$/
    );
    expect(at(/^CREATE INDEX "idx_message_embedding"/)).toBeGreaterThan(rebuild);
    expect(mockLoggerInfo).toHaveBeenCalledWith('✅ Embeddings reset complete', {
      dimensions: 1024,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls back to 1536 dimensions when no embedding model is active', async () => {
    process.argv = [...argv, '--yes'];
    mockActiveModel.mockResolvedValue(null);

    await runScript();

    expect(statements()).toContain(
      'ALTER TABLE "ai_message_embedding" ADD COLUMN "embedding" vector(1536) NOT NULL'
    );
  });

  it('changes nothing when the operator does not answer yes', async () => {
    mockAnswer.mockResolvedValue('no');
    // process.exit is stubbed, so stop the run where it would have ended.
    // Only there: the catch's exit(1) that follows must not throw again.
    exitSpy.mockImplementation((code: number) => {
      if (code === 0) throw new Error('exit 0');
    });

    await runScript();

    expect(exitSpy.mock.calls[0]).toEqual([0]);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith('🟡 Aborted by user — no changes made.');
  });

  it('logs a failure and exits 1', async () => {
    process.argv = [...argv, '--yes'];
    const failure = new Error('permission denied for table ai_message');
    mockExecute.mockRejectedValueOnce(failure);

    await runScript();

    expect(mockLoggerError).toHaveBeenCalledWith('❌ Embeddings reset failed', failure);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
