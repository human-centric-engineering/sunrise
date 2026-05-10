/**
 * Cost Tracker — transcription operation tests
 *
 * Covers:
 * - calculateTranscriptionCost — per-minute math, zero/negative duration → $0
 * - logCost with operation='transcription' — derives cost from durationMs
 *   (not tokens), writes durationMs into metadata, and persists with
 *   operation='transcription'
 *
 * @see lib/orchestration/llm/cost-tracker.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCostLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    aiAgent: { findUnique: vi.fn() },
    aiOrchestrationSettings: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { logCost, calculateTranscriptionCost, WHISPER_USD_PER_MINUTE } =
  await import('@/lib/orchestration/llm/cost-tracker');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiCostLog.create).mockResolvedValue({ id: 'cost-1' } as never);
});

describe('calculateTranscriptionCost', () => {
  it('computes $0.006 per minute (60_000 ms → WHISPER_USD_PER_MINUTE)', () => {
    const cost = calculateTranscriptionCost(60_000);
    expect(cost.totalCostUsd).toBeCloseTo(WHISPER_USD_PER_MINUTE);
    expect(cost.inputCostUsd).toBeCloseTo(WHISPER_USD_PER_MINUTE);
    expect(cost.outputCostUsd).toBe(0);
    expect(cost.isLocal).toBe(false);
  });

  it('scales linearly for sub-minute durations', () => {
    // 30 seconds = half a minute = WHISPER_USD_PER_MINUTE / 2
    const cost = calculateTranscriptionCost(30_000);
    expect(cost.totalCostUsd).toBeCloseTo(WHISPER_USD_PER_MINUTE / 2);
  });

  it('returns $0 for zero duration', () => {
    const cost = calculateTranscriptionCost(0);
    expect(cost.totalCostUsd).toBe(0);
  });

  it('returns $0 for negative or non-finite durations', () => {
    expect(calculateTranscriptionCost(-1).totalCostUsd).toBe(0);
    expect(calculateTranscriptionCost(NaN).totalCostUsd).toBe(0);
    expect(calculateTranscriptionCost(Infinity).totalCostUsd).toBe(0);
  });
});

describe("logCost with operation='transcription'", () => {
  it('derives cost from durationMs and ignores token counts', async () => {
    await logCost({
      agentId: 'agent-1',
      model: 'whisper-1',
      provider: 'openai',
      inputTokens: 0,
      outputTokens: 0,
      operation: 'transcription',
      durationMs: 30_000,
    });

    expect(prisma.aiCostLog.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(data.operation).toBe('transcription');
    expect(data.totalCostUsd).toBeCloseTo(WHISPER_USD_PER_MINUTE / 2);
    expect(data.inputTokens).toBe(0);
    expect(data.outputTokens).toBe(0);
    expect(data.agentId).toBe('agent-1');
    expect(data.provider).toBe('openai');
  });

  it('writes durationMs into the metadata column', async () => {
    await logCost({
      agentId: 'agent-1',
      model: 'whisper-1',
      provider: 'openai',
      inputTokens: 0,
      outputTokens: 0,
      operation: 'transcription',
      durationMs: 12_345,
    });

    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(data.metadata).toMatchObject({ durationMs: 12_345 });
  });

  it('preserves caller metadata alongside durationMs', async () => {
    await logCost({
      agentId: 'agent-1',
      model: 'whisper-1',
      provider: 'openai',
      inputTokens: 0,
      outputTokens: 0,
      operation: 'transcription',
      durationMs: 5_000,
      metadata: { language: 'en', conversationId: 'c-1' },
    });

    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(data.metadata).toMatchObject({
      durationMs: 5_000,
      language: 'en',
      conversationId: 'c-1',
    });
  });

  it('records $0 cost when durationMs is omitted (provider returned no usage)', async () => {
    await logCost({
      agentId: 'agent-1',
      model: 'whisper-1',
      provider: 'openai',
      inputTokens: 0,
      outputTokens: 0,
      operation: 'transcription',
    });

    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(data.totalCostUsd).toBe(0);
    // When durationMs is absent we don't synthesise a metadata object — the
    // chat path should not look at this column for non-transcription rows.
    expect(data.metadata).toBeUndefined();
  });

  it('still uses token-based pricing for chat operations (regression guard)', async () => {
    await logCost({
      agentId: 'agent-1',
      model: 'whisper-1', // unknown to the registry — would be 0 anyway
      provider: 'openai',
      inputTokens: 1000,
      outputTokens: 500,
      operation: 'chat',
      durationMs: 30_000, // ignored because operation !== 'transcription'
    });

    const data = vi.mocked(prisma.aiCostLog.create).mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    // Critical: chat path must NOT use the transcription per-minute calc even
    // if a stray durationMs slips in from the caller — and unknown models
    // resolve to $0 via the model registry, not via duration.
    expect(data.totalCostUsd).toBe(0);
    expect(data.metadata).toBeUndefined();
  });
});
