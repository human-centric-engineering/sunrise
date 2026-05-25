/**
 * Unit tests for appendCasesToDataset.
 *
 * Coverage:
 * - Throws on empty input
 * - Throws when the dataset doesn't exist
 * - Throws when the resulting case count would exceed MAX_CASES
 * - Validates each case via the same schema upload uses
 * - Recomputes contentHash from the *new full* case array
 * - Increments caseCount by exactly the number of new rows
 * - Updates `source` only when the new value differs from the existing
 *
 * @see lib/orchestration/evaluations/datasets/append-cases.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTx = {
  aiDataset: { findUnique: vi.fn(), update: vi.fn() },
  aiDatasetCase: { createMany: vi.fn(), findMany: vi.fn() },
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/evaluations/datasets/hash', () => ({
  hashDatasetCases: vi.fn(() => 'new-content-hash'),
}));

import { appendCasesToDataset } from '@/lib/orchestration/evaluations/datasets/append-cases';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('appendCasesToDataset — validation', () => {
  it('throws when given an empty cases array', async () => {
    await expect(appendCasesToDataset({ datasetId: 'ds-1', cases: [] })).rejects.toThrow(
      /at least one case/i
    );
  });

  it('throws when a case fails schema validation (empty input)', async () => {
    await expect(
      appendCasesToDataset({
        datasetId: 'ds-1',
        cases: [{ input: '' }],
      })
    ).rejects.toThrow(/Case at position 0 is invalid/);
  });
});

describe('appendCasesToDataset — happy path', () => {
  it('appends cases at the next contiguous position and recomputes the hash', async () => {
    mockTx.aiDataset.findUnique.mockResolvedValue({
      id: 'ds-1',
      caseCount: 3,
      source: 'upload',
    });
    mockTx.aiDatasetCase.findMany.mockResolvedValue([
      { position: 0, input: 'a', expectedOutput: null, metadata: null, referenceCitations: null },
      { position: 1, input: 'b', expectedOutput: null, metadata: null, referenceCitations: null },
      { position: 2, input: 'c', expectedOutput: null, metadata: null, referenceCitations: null },
      { position: 3, input: 'd', expectedOutput: null, metadata: null, referenceCitations: null },
      { position: 4, input: 'e', expectedOutput: null, metadata: null, referenceCitations: null },
    ]);
    mockTx.aiDatasetCase.createMany.mockResolvedValue({ count: 2 });
    mockTx.aiDataset.update.mockResolvedValue({ id: 'ds-1' });

    const result = await appendCasesToDataset({
      datasetId: 'ds-1',
      cases: [{ input: 'd' }, { input: 'e' }],
      source: 'conversation_capture',
    });

    expect(result).toEqual({
      datasetId: 'ds-1',
      appendedCount: 2,
      newCaseCount: 5,
      newContentHash: 'new-content-hash',
    });
    // Positions are 3 and 4 (existing caseCount=3, append 2 more)
    expect(mockTx.aiDatasetCase.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ datasetId: 'ds-1', position: 3, input: 'd' }),
        expect.objectContaining({ datasetId: 'ds-1', position: 4, input: 'e' }),
      ],
    });
    expect(mockTx.aiDataset.update).toHaveBeenCalledWith({
      where: { id: 'ds-1' },
      data: expect.objectContaining({
        caseCount: 5,
        contentHash: 'new-content-hash',
        source: 'conversation_capture',
      }),
    });
  });

  it('does not change source when it is already the requested value', async () => {
    mockTx.aiDataset.findUnique.mockResolvedValue({
      id: 'ds-1',
      caseCount: 1,
      source: 'conversation_capture',
    });
    mockTx.aiDatasetCase.findMany.mockResolvedValue([
      { position: 0, input: 'a', expectedOutput: null, metadata: null, referenceCitations: null },
      { position: 1, input: 'b', expectedOutput: null, metadata: null, referenceCitations: null },
    ]);
    mockTx.aiDatasetCase.createMany.mockResolvedValue({ count: 1 });
    mockTx.aiDataset.update.mockResolvedValue({ id: 'ds-1' });

    await appendCasesToDataset({
      datasetId: 'ds-1',
      cases: [{ input: 'b' }],
      source: 'conversation_capture',
    });

    const updateArgs = mockTx.aiDataset.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('source');
  });

  it('throws when the dataset row is missing', async () => {
    mockTx.aiDataset.findUnique.mockResolvedValue(null);

    await expect(
      appendCasesToDataset({ datasetId: 'ds-missing', cases: [{ input: 'a' }] })
    ).rejects.toThrow(/Dataset ds-missing not found/);
  });

  it('throws when the resulting case count would exceed the 10,000 cap', async () => {
    mockTx.aiDataset.findUnique.mockResolvedValue({
      id: 'ds-big',
      caseCount: 9_999,
      source: 'upload',
    });

    await expect(
      appendCasesToDataset({
        datasetId: 'ds-big',
        cases: [{ input: 'a' }, { input: 'b' }],
      })
    ).rejects.toThrow(/10000-case cap/);
  });
});
