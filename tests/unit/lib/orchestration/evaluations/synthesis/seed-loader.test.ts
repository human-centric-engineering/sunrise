/**
 * Unit tests for the synthesis seed loaders.
 *
 * Coverage:
 * - loadKbSeed: full-access mode skips the doc filter
 * - loadKbSeed: restricted mode joins granted + system docs
 * - loadKbSeed: restricted + zero grants returns []
 * - loadKbSeed: chunks are truncated to MAX_KB_CHUNK_CHARS
 * - loadKbSeed: query failure falls back to []
 * - loadFailureSeed: empty when no completed runs exist
 * - loadFailureSeed: filters to mean-score < 0.6 across metricScores
 * - loadFailureSeed: surfaces worst-grader reasoning, truncated
 * - loadFailureSeed: query failure falls back to []
 *
 * @see lib/orchestration/evaluations/synthesis/seed-loader.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeChunk: { findMany: vi.fn() },
    aiKnowledgeDocument: { findMany: vi.fn() },
    aiEvaluationRun: { findMany: vi.fn() },
    aiEvaluationCaseResult: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  resolveAgentDocumentAccess: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { resolveAgentDocumentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { loadFailureSeed, loadKbSeed } from '@/lib/orchestration/evaluations/synthesis/seed-loader';

const mockedResolveAccess = vi.mocked(resolveAgentDocumentAccess);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadKbSeed — full-access mode', () => {
  it('queries chunks without a document filter and maps the result', async () => {
    mockedResolveAccess.mockResolvedValue({ mode: 'full' });
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      {
        documentId: 'd1',
        content: 'Refunds within 30 days.',
        chunkType: 'overview',
        document: { name: 'Refund policy' },
      },
    ] as never);

    const result = await loadKbSeed({ agentId: 'a-1' });

    expect(result).toEqual([
      {
        documentId: 'd1',
        documentName: 'Refund policy',
        chunkType: 'overview',
        content: 'Refunds within 30 days.',
      },
    ]);
    const findManyArgs = vi.mocked(prisma.aiKnowledgeChunk.findMany).mock.calls[0][0];
    expect(findManyArgs?.where).toEqual({});
  });

  it('caps the result at MAX_KB_CHUNKS even when the caller passes a larger limit', async () => {
    mockedResolveAccess.mockResolvedValue({ mode: 'full' });
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    await loadKbSeed({ agentId: 'a-1', limit: 999 });
    const args = vi.mocked(prisma.aiKnowledgeChunk.findMany).mock.calls[0][0];
    expect(args?.take).toBe(12);
  });

  it('truncates chunk content to ~800 chars with an ellipsis', async () => {
    mockedResolveAccess.mockResolvedValue({ mode: 'full' });
    const longContent = 'x'.repeat(1500);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      {
        documentId: 'd1',
        content: longContent,
        chunkType: 'overview',
        document: { name: 'Long doc' },
      },
    ] as never);

    const result = await loadKbSeed({ agentId: 'a-1' });
    expect(result[0].content.length).toBeLessThanOrEqual(801); // 800 + ellipsis char
    expect(result[0].content.endsWith('…')).toBe(true);
  });
});

describe('loadKbSeed — restricted mode', () => {
  it('joins granted doc IDs with system-scope docs when includeSystemScope is true', async () => {
    mockedResolveAccess.mockResolvedValue({
      mode: 'restricted',
      documentIds: ['granted-1', 'granted-2'],
      includeSystemScope: true,
    });
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      { id: 'sys-1' },
      { id: 'sys-2' },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    await loadKbSeed({ agentId: 'a-1' });

    const args = vi.mocked(prisma.aiKnowledgeChunk.findMany).mock.calls[0][0];
    expect(args?.where).toEqual({
      documentId: { in: expect.arrayContaining(['granted-1', 'granted-2', 'sys-1', 'sys-2']) },
    });
  });

  it('returns [] when the agent has no granted docs (restricted mode, no system scope)', async () => {
    mockedResolveAccess.mockResolvedValue({
      mode: 'restricted',
      documentIds: [],
      includeSystemScope: true,
    });
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([] as never);

    const result = await loadKbSeed({ agentId: 'a-1' });

    expect(result).toEqual([]);
    expect(vi.mocked(prisma.aiKnowledgeChunk.findMany)).not.toHaveBeenCalled();
  });
});

describe('loadKbSeed — error handling', () => {
  it('falls back to [] when the chunk query throws', async () => {
    mockedResolveAccess.mockResolvedValue({ mode: 'full' });
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockRejectedValue(new Error('db down'));

    const result = await loadKbSeed({ agentId: 'a-1' });
    expect(result).toEqual([]);
  });
});

describe('loadFailureSeed — no data', () => {
  it('returns [] when no completed runs exist for the agent', async () => {
    vi.mocked(prisma.aiEvaluationRun.findMany).mockResolvedValue([] as never);

    const result = await loadFailureSeed({ agentId: 'a-1', userId: 'u-1' });
    expect(result).toEqual([]);
    expect(vi.mocked(prisma.aiEvaluationCaseResult.findMany)).not.toHaveBeenCalled();
  });
});

describe('loadFailureSeed — score filtering', () => {
  beforeEach(() => {
    vi.mocked(prisma.aiEvaluationRun.findMany).mockResolvedValue([{ id: 'run-1' }] as never);
  });

  it('returns only cases whose mean metricScore is below the 0.6 threshold', async () => {
    vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([
      {
        datasetCaseId: 'case-good',
        metricScores: {
          'eval-judge-relevance': { score: 0.9, reasoning: 'nice' },
        },
        datasetCase: { input: 'good q', expectedOutput: 'good a' },
      },
      {
        datasetCaseId: 'case-bad',
        metricScores: {
          'eval-judge-relevance': { score: 0.2, reasoning: 'missed citation' },
          'eval-judge-faithfulness': { score: 0.4, reasoning: 'partial cite' },
        },
        datasetCase: { input: 'bad q', expectedOutput: 'bad a' },
      },
    ] as never);

    const result = await loadFailureSeed({ agentId: 'a-1', userId: 'u-1' });

    expect(result).toHaveLength(1);
    expect(result[0].caseId).toBe('case-bad');
    // mean(0.2, 0.4) = 0.3
    expect(result[0].score).toBeCloseTo(0.3, 6);
  });

  it('surfaces the worst-scoring grader reasoning', async () => {
    vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([
      {
        datasetCaseId: 'case-x',
        metricScores: {
          a: { score: 0.5, reasoning: 'okay-ish' },
          b: { score: 0.1, reasoning: 'really bad — missed all citations' },
        },
        datasetCase: { input: 'q', expectedOutput: 'a' },
      },
    ] as never);

    const result = await loadFailureSeed({ agentId: 'a-1', userId: 'u-1' });
    expect(result[0].reasoning).toContain('really bad');
  });

  it('truncates very long reasoning text', async () => {
    const longReason = 'x'.repeat(800);
    vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([
      {
        datasetCaseId: 'case-x',
        metricScores: {
          a: { score: 0.2, reasoning: longReason },
        },
        datasetCase: { input: 'q', expectedOutput: 'a' },
      },
    ] as never);

    const result = await loadFailureSeed({ agentId: 'a-1', userId: 'u-1' });
    expect((result[0].reasoning ?? '').length).toBeLessThan(longReason.length);
    expect(result[0].reasoning?.endsWith('…')).toBe(true);
  });

  it('deduplicates by datasetCaseId across multiple runs', async () => {
    vi.mocked(prisma.aiEvaluationCaseResult.findMany).mockResolvedValue([
      {
        datasetCaseId: 'case-dup',
        metricScores: { a: { score: 0.2 } },
        datasetCase: { input: 'q', expectedOutput: 'a' },
      },
      {
        datasetCaseId: 'case-dup',
        metricScores: { a: { score: 0.3 } },
        datasetCase: { input: 'q', expectedOutput: 'a' },
      },
    ] as never);

    const result = await loadFailureSeed({ agentId: 'a-1', userId: 'u-1' });
    expect(result.filter((r) => r.caseId === 'case-dup')).toHaveLength(1);
  });
});

describe('loadFailureSeed — error handling', () => {
  it('falls back to [] when the runs query throws', async () => {
    vi.mocked(prisma.aiEvaluationRun.findMany).mockRejectedValue(new Error('db down'));

    const result = await loadFailureSeed({ agentId: 'a-1', userId: 'u-1' });
    expect(result).toEqual([]);
  });
});

describe('loadFailureSeed — cross-user isolation', () => {
  it('scopes the past-runs query to the caller userId so admin B cannot pull admin A runs', async () => {
    vi.mocked(prisma.aiEvaluationRun.findMany).mockResolvedValue([] as never);

    await loadFailureSeed({ agentId: 'shared-agent', userId: 'caller-id' });

    const args = vi.mocked(prisma.aiEvaluationRun.findMany).mock.calls[0][0];
    expect(args?.where).toMatchObject({
      agentId: 'shared-agent',
      userId: 'caller-id',
      subjectKind: 'agent',
      status: 'completed',
    });
  });
});
