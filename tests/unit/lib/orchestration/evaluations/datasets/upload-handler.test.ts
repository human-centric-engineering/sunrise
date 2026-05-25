/**
 * Unit tests for `uploadDataset` — the format-agnostic dataset upload handler.
 *
 * Real parsers (CSV + JSONL) drive the case extraction; Prisma is mocked
 * so we can assert on the AiDataset.create + AiDatasetCase.createMany
 * calls inside the `$transaction` block. The contentHash is delegated to
 * `hashParsedCases`, so we verify identity (round-trip through the real
 * hash module) rather than exact bytes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ── Mocks ──────────────────────────────────────────────────────────────

const txMocks = {
  aiDatasetCreate: vi.fn(),
  aiDatasetCaseCreateMany: vi.fn(),
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiDataset: { create: vi.fn() },
    aiDatasetCase: { createMany: vi.fn() },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        aiDataset: { create: txMocks.aiDatasetCreate },
        aiDatasetCase: { createMany: txMocks.aiDatasetCaseCreateMany },
      })
    ),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

const { prisma } = await import('@/lib/db/client');
const { logger } = await import('@/lib/logging');
const { uploadDataset } = await import('@/lib/orchestration/evaluations/datasets/upload-handler');
const { hashParsedCases } = await import('@/lib/orchestration/evaluations/datasets/hash');
const { ValidationError } = await import('@/lib/api/errors');

const mockedTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const mockedLoggerInfo = logger.info as unknown as ReturnType<typeof vi.fn>;

// ── Helpers ────────────────────────────────────────────────────────────

function baseParams(overrides: Partial<Parameters<typeof uploadDataset>[0]> = {}) {
  return {
    userId: 'user-1',
    name: 'My Dataset',
    fileName: 'cases.csv',
    content: 'input,expectedOutput\nQ1,A1\nQ2,A2\n',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txMocks.aiDatasetCreate.mockReset();
  txMocks.aiDatasetCaseCreateMany.mockReset();
  txMocks.aiDatasetCreate.mockResolvedValue({ id: 'dataset-1' });
  txMocks.aiDatasetCaseCreateMany.mockResolvedValue({ count: 0 });
});

// ── Happy paths ────────────────────────────────────────────────────────

describe('uploadDataset — CSV happy path', () => {
  it('parses CSV, writes dataset + cases, returns datasetId/caseCount/contentHash', async () => {
    const result = await uploadDataset(baseParams());

    expect(result).toMatchObject({
      datasetId: 'dataset-1',
      caseCount: 2,
      warnings: [],
    });

    // Hash matches what we'd compute from the parsed cases directly.
    expect(result.contentHash).toBe(
      hashParsedCases([
        { input: 'Q1', expectedOutput: 'A1' },
        { input: 'Q2', expectedOutput: 'A2' },
      ])
    );
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // Transaction was used.
    expect(mockedTransaction).toHaveBeenCalledTimes(1);

    // Dataset row.
    expect(txMocks.aiDatasetCreate).toHaveBeenCalledTimes(1);
    expect(txMocks.aiDatasetCreate.mock.calls[0][0]).toMatchObject({
      data: {
        userId: 'user-1',
        name: 'My Dataset',
        description: null,
        tags: [],
        caseCount: 2,
        contentHash: result.contentHash,
        source: 'upload',
      },
    });

    // Case rows.
    expect(txMocks.aiDatasetCaseCreateMany).toHaveBeenCalledTimes(1);
    const caseManyArg = txMocks.aiDatasetCaseCreateMany.mock.calls[0][0] as {
      data: Array<{
        datasetId: string;
        position: number;
        input: unknown;
        expectedOutput: string | null;
        metadata: unknown;
        referenceCitations: unknown;
      }>;
    };
    expect(caseManyArg.data).toHaveLength(2);
    expect(caseManyArg.data[0]).toMatchObject({
      datasetId: 'dataset-1',
      position: 0,
      input: 'Q1',
      expectedOutput: 'A1',
    });
    expect(caseManyArg.data[1]).toMatchObject({
      datasetId: 'dataset-1',
      position: 1,
      input: 'Q2',
      expectedOutput: 'A2',
    });

    // Logged.
    expect(mockedLoggerInfo).toHaveBeenCalledWith(
      'Dataset uploaded',
      expect.objectContaining({
        datasetId: 'dataset-1',
        userId: 'user-1',
        caseCount: 2,
        contentHash: result.contentHash,
      })
    );
  });

  it('passes description and tags straight through when supplied', async () => {
    await uploadDataset(
      baseParams({
        description: 'Refund cases',
        tags: ['refund', 'edge-case'],
      })
    );

    expect(txMocks.aiDatasetCreate.mock.calls[0][0].data).toMatchObject({
      description: 'Refund cases',
      tags: ['refund', 'edge-case'],
    });
  });
});

describe('uploadDataset — JSONL happy path', () => {
  it('parses .jsonl, writes rows, surfaces parser warnings', async () => {
    const jsonl =
      '# header\n{"input":"A","expectedOutput":"a"}\n{"input":{"sku":"ABC"},"metadata":{"x":1}}\n';
    const result = await uploadDataset(baseParams({ fileName: 'cases.jsonl', content: jsonl }));

    expect(result.caseCount).toBe(2);
    const caseManyArg = txMocks.aiDatasetCaseCreateMany.mock.calls[0][0] as {
      data: Array<{ input: unknown; metadata: unknown; expectedOutput: string | null }>;
    };
    expect(caseManyArg.data[0].input).toBe('A');
    expect(caseManyArg.data[0].expectedOutput).toBe('a');
    expect(caseManyArg.data[1].input).toEqual({ sku: 'ABC' });
    expect(caseManyArg.data[1].metadata).toEqual({ x: 1 });

    // Hash deterministic against parsed cases.
    expect(result.contentHash).toBe(
      hashParsedCases([
        { input: 'A', expectedOutput: 'a' },
        { input: { sku: 'ABC' }, metadata: { x: 1 } },
      ])
    );
  });

  it('treats .ndjson extension as JSONL', async () => {
    const ndjson = '{"input":"first"}\n{"input":"second"}\n';
    const result = await uploadDataset(baseParams({ fileName: 'cases.ndjson', content: ndjson }));

    expect(result.caseCount).toBe(2);
    const caseManyArg = txMocks.aiDatasetCaseCreateMany.mock.calls[0][0] as {
      data: Array<{ input: unknown }>;
    };
    expect(caseManyArg.data.map((c) => c.input)).toEqual(['first', 'second']);
  });

  it('surfaces parser warnings in the result', async () => {
    // CSV with an empty middle row triggers a parser warning.
    const csv = 'input\nA\n\nB\n';
    const result = await uploadDataset(baseParams({ fileName: 'cases.csv', content: csv }));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => /empty row/i.test(w))).toBe(true);
    expect(mockedLoggerInfo.mock.calls[0][1]).toMatchObject({
      parseWarnings: result.warnings.length,
    });
  });
});

// ── Prisma.DbNull / Prisma.InputJsonValue mapping ──────────────────────

describe('uploadDataset — metadata + referenceCitations mapping', () => {
  it('passes metadata + referenceCitations as JSON when defined', async () => {
    const jsonl =
      '{"input":"Q","expectedOutput":"A","metadata":{"tags":["t1"]},"referenceCitations":[{"id":"c1"}]}\n';
    await uploadDataset(baseParams({ fileName: 'd.jsonl', content: jsonl }));

    const row = (
      txMocks.aiDatasetCaseCreateMany.mock.calls[0][0] as {
        data: Array<{ metadata: unknown; referenceCitations: unknown }>;
      }
    ).data[0];
    expect(row.metadata).toEqual({ tags: ['t1'] });
    expect(row.referenceCitations).toEqual([{ id: 'c1' }]);
    // Not the DbNull sentinel.
    expect(row.metadata).not.toBe(Prisma.DbNull);
    expect(row.referenceCitations).not.toBe(Prisma.DbNull);
  });

  it('writes Prisma.DbNull when metadata + referenceCitations are absent', async () => {
    const jsonl = '{"input":"Q"}\n';
    await uploadDataset(baseParams({ fileName: 'd.jsonl', content: jsonl }));

    const row = (
      txMocks.aiDatasetCaseCreateMany.mock.calls[0][0] as {
        data: Array<{ metadata: unknown; referenceCitations: unknown; expectedOutput: unknown }>;
      }
    ).data[0];
    expect(row.metadata).toBe(Prisma.DbNull);
    expect(row.referenceCitations).toBe(Prisma.DbNull);
    expect(row.expectedOutput).toBeNull();
  });
});

// ── Source detection ──────────────────────────────────────────────────

describe('uploadDataset — source detection', () => {
  it('always reports source: "upload" (Phase 1 default)', async () => {
    await uploadDataset(baseParams());
    expect(txMocks.aiDatasetCreate.mock.calls[0][0].data.source).toBe('upload');
  });
});

// ── Validation errors ──────────────────────────────────────────────────

describe('uploadDataset — validation errors', () => {
  it('throws ValidationError on unsupported file extension', async () => {
    await expect(
      uploadDataset(baseParams({ fileName: 'cases.xlsx', content: 'whatever' }))
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidationError on no extension at all', async () => {
    await expect(
      uploadDataset(baseParams({ fileName: 'README', content: 'no ext' }))
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('wraps DatasetParseError from the parser as a ValidationError', async () => {
    // Malformed JSONL — parser throws DatasetParseError, handler re-wraps.
    await expect(
      uploadDataset(baseParams({ fileName: 'bad.jsonl', content: '{"input":"A"}\n{bad json\n' }))
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringMatching(/Dataset parse failed/),
    });
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidationError on > 10k cases', async () => {
    // Generate a JSONL with 10001 entries.
    const lines: string[] = [];
    for (let i = 0; i < 10_001; i++) {
      lines.push(`{"input":"q${i}"}`);
    }
    await expect(
      uploadDataset(baseParams({ fileName: 'huge.jsonl', content: lines.join('\n') + '\n' }))
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringMatching(/10000.*cap.*10001/i),
    });
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidationError with position when a case fails Zod (> 50k char input)', async () => {
    const huge = 'x'.repeat(50_001);
    const jsonl = `{"input":"ok"}\n{"input":${JSON.stringify(huge)}}\n`;
    await expect(
      uploadDataset(baseParams({ fileName: 'big.jsonl', content: jsonl }))
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringMatching(/Case at position 1 is invalid/),
    });
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidationError with position when a case fails Zod (> 50k char expectedOutput)', async () => {
    const huge = 'y'.repeat(50_001);
    const jsonl = `{"input":"ok","expectedOutput":${JSON.stringify(huge)}}\n`;
    await expect(
      uploadDataset(baseParams({ fileName: 'big.jsonl', content: jsonl }))
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringMatching(/Case at position 0 is invalid/),
    });
  });

  it('throws ValidationError when object-shaped input is an empty object', async () => {
    // refine() in upload-handler rejects {} — covers the refine path.
    const jsonl = `{"input":{}}\n`;
    await expect(
      uploadDataset(baseParams({ fileName: 'empty-obj.jsonl', content: jsonl }))
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringMatching(/Case at position 0/),
    });
  });

  it('lets unexpected (non-DatasetParseError, non-Validation) errors propagate', async () => {
    // .csv extension forces csv path; spy on a tx that throws something else
    // *after* parsing succeeds, to prove non-parse errors bubble.
    txMocks.aiDatasetCreate.mockRejectedValueOnce(new Error('db blew up'));
    await expect(uploadDataset(baseParams())).rejects.toMatchObject({
      message: 'db blew up',
    });
  });
});
