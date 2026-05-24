import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpExposedPrompt: { findUnique: vi.fn() },
    mcpExposedResource: { findUnique: vi.fn() },
  },
}));

import {
  completeMcpReference,
  MAX_COMPLETION_CANDIDATES,
  MAX_PARTIAL_LENGTH,
  MAX_STORED_CANDIDATES_PER_ARG,
} from '@/lib/orchestration/mcp/completion-registry';
import { prisma } from '@/lib/db/client';

beforeEach(() => vi.clearAllMocks());

describe('completeMcpReference: prompts', () => {
  it('returns prefix-filtered values from completionsSpec', async () => {
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue({
      completionsSpec: { country: ['france', 'finland', 'germany'] },
    } as never);

    const result = await completeMcpReference(
      { type: 'ref/prompt', name: 'travel' },
      'country',
      'f'
    );

    expect(result.completion.values.sort()).toEqual(['finland', 'france']);
    expect(result.completion.hasMore).toBe(false);
    expect(result.completion.total).toBe(2);
  });

  it('prefix match is case-insensitive', async () => {
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue({
      completionsSpec: { country: ['France', 'Finland'] },
    } as never);

    const result = await completeMcpReference(
      { type: 'ref/prompt', name: 'travel' },
      'country',
      'f'
    );
    expect(result.completion.values).toHaveLength(2);
  });

  it('returns all candidates when partial is empty', async () => {
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue({
      completionsSpec: { x: ['a', 'b', 'c'] },
    } as never);

    const result = await completeMcpReference({ type: 'ref/prompt', name: 'p' }, 'x', '');
    expect(result.completion.values).toEqual(['a', 'b', 'c']);
  });

  it('returns empty when the prompt has no completionsSpec', async () => {
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue({
      completionsSpec: null,
    } as never);

    const result = await completeMcpReference({ type: 'ref/prompt', name: 'p' }, 'x', '');
    expect(result.completion.values).toEqual([]);
  });

  it('returns empty when the prompt does not exist', async () => {
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue(null);
    const result = await completeMcpReference({ type: 'ref/prompt', name: 'missing' }, 'x', '');
    expect(result.completion.values).toEqual([]);
  });

  it('caps returned values at MAX_COMPLETION_CANDIDATES with hasMore=true', async () => {
    const big = Array.from({ length: 200 }, (_, i) => `value-${String(i).padStart(3, '0')}`);
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue({
      completionsSpec: { x: big },
    } as never);

    const result = await completeMcpReference({ type: 'ref/prompt', name: 'p' }, 'x', '');
    expect(result.completion.values).toHaveLength(MAX_COMPLETION_CANDIDATES);
    expect(result.completion.hasMore).toBe(true);
  });

  it('caps stored candidates at 500 (admin can save more but only 500 are considered)', async () => {
    const huge = Array.from({ length: 600 }, (_, i) => `v${String(i)}`);
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue({
      completionsSpec: { x: huge },
    } as never);
    const result = await completeMcpReference({ type: 'ref/prompt', name: 'p' }, 'x', '');
    // 500 candidates exist; 100 returned (the cap); hasMore reflects the 500 set.
    expect(result.completion.values).toHaveLength(MAX_COMPLETION_CANDIDATES);
    expect(result.completion.total).toBe(MAX_STORED_CANDIDATES_PER_ARG);
  });

  it('throws RangeError when partial value exceeds 1024 chars', async () => {
    await expect(
      completeMcpReference(
        { type: 'ref/prompt', name: 'p' },
        'x',
        'x'.repeat(MAX_PARTIAL_LENGTH + 1)
      )
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('tolerates non-string entries in the candidate list', async () => {
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue({
      completionsSpec: { x: ['ok', 42, null, { o: 1 }, 'also-ok'] },
    } as never);
    const result = await completeMcpReference({ type: 'ref/prompt', name: 'p' }, 'x', '');
    expect(result.completion.values).toEqual(['ok', 'also-ok']);
  });
});

describe('completeMcpReference: resources', () => {
  it('enumerates pattern numbers 1-21 dynamically for patterns/{number}', async () => {
    const result = await completeMcpReference(
      { type: 'ref/resource', uri: 'sunrise://knowledge/patterns/{number}' },
      'number',
      '1'
    );
    // 1, 10, 11, 12, …, 19 (10 values), and 1 itself = 11
    expect(result.completion.values).toContain('1');
    expect(result.completion.values).toContain('19');
    expect(result.completion.values).not.toContain('21'); // doesn't start with "1"
    // findUnique never called for the patterns special case
    expect(prisma.mcpExposedResource.findUnique).not.toHaveBeenCalled();
  });

  it('reads completionsSpec from a resource handlerConfig', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue({
      handlerConfig: { completionsSpec: { region: ['us', 'eu', 'apac'] } },
    } as never);

    const result = await completeMcpReference(
      { type: 'ref/resource', uri: 'sunrise://reports' },
      'region',
      'e'
    );

    expect(result.completion.values).toEqual(['eu']);
  });

  it('returns empty when resource has no completionsSpec', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue({
      handlerConfig: { other: 'thing' },
    } as never);

    const result = await completeMcpReference(
      { type: 'ref/resource', uri: 'sunrise://reports' },
      'region',
      ''
    );
    expect(result.completion.values).toEqual([]);
  });

  it('returns empty when resource has no handlerConfig at all', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue({
      handlerConfig: null,
    } as never);

    const result = await completeMcpReference(
      { type: 'ref/resource', uri: 'sunrise://reports' },
      'region',
      ''
    );
    expect(result.completion.values).toEqual([]);
  });
});
