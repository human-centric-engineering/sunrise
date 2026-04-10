/**
 * Tests for GetPatternDetailCapability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  getPatternDetail: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { getPatternDetail } = await import('@/lib/orchestration/knowledge/search');
const { GetPatternDetailCapability } =
  await import('@/lib/orchestration/capabilities/built-in/get-pattern-detail');
const { CapabilityValidationError } =
  await import('@/lib/orchestration/capabilities/base-capability');

const context = { userId: 'u1', agentId: 'a1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GetPatternDetailCapability', () => {
  it('delegates to getPatternDetail and shapes the response', async () => {
    (getPatternDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      patternName: 'ReAct',
      totalTokens: 123,
      chunks: [
        {
          id: 'c1',
          chunkKey: 'pattern-1:overview',
          section: 'overview',
          content: 'Overview text',
          estimatedTokens: 50,
        },
        {
          id: 'c2',
          chunkKey: 'pattern-1:how',
          section: 'how_it_works',
          content: 'How it works',
          estimatedTokens: 73,
        },
      ],
    });
    const cap = new GetPatternDetailCapability();

    const result = await cap.execute({ pattern_number: 1 }, context);

    expect(getPatternDetail).toHaveBeenCalledWith(1);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      patternNumber: 1,
      patternName: 'ReAct',
      totalTokens: 123,
      chunks: [
        { chunkId: 'c1', section: 'overview' },
        { chunkId: 'c2', section: 'how_it_works' },
      ],
    });
  });

  it('returns not_found when no chunks come back', async () => {
    (getPatternDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      patternName: null,
      chunks: [],
      totalTokens: 0,
    });
    const cap = new GetPatternDetailCapability();

    const result = await cap.execute({ pattern_number: 999 }, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_found');
  });

  it('rejects non-integer pattern numbers via validate()', () => {
    const cap = new GetPatternDetailCapability();
    expect(() => cap.validate({ pattern_number: 1.5 })).toThrow(CapabilityValidationError);
  });

  it('rejects out-of-range pattern numbers via validate()', () => {
    const cap = new GetPatternDetailCapability();
    expect(() => cap.validate({ pattern_number: 0 })).toThrow(CapabilityValidationError);
    expect(() => cap.validate({ pattern_number: 1000 })).toThrow(CapabilityValidationError);
  });
});
