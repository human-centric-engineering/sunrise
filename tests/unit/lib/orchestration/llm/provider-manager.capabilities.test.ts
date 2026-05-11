import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));

const mockFindFirst = vi.fn();
const mockCount = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
  },
}));

import {
  assertModelSupportsAttachments,
  hasModelWithCapability,
} from '@/lib/orchestration/llm/provider-manager';
import { ProviderError } from '@/lib/orchestration/llm/provider';

beforeEach(() => {
  mockFindFirst.mockReset();
  mockCount.mockReset();
});

describe('assertModelSupportsAttachments', () => {
  it('is a no-op when the required list is empty', async () => {
    await expect(
      assertModelSupportsAttachments('anthropic', 'claude-sonnet-4', [])
    ).resolves.toBeUndefined();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('passes when the matrix row has every required capability', async () => {
    mockFindFirst.mockResolvedValue({
      capabilities: ['chat', 'vision', 'documents'],
    });
    await expect(
      assertModelSupportsAttachments('anthropic', 'claude-sonnet-4', ['vision', 'documents'])
    ).resolves.toBeUndefined();
  });

  it('throws CAPABILITY_NOT_SUPPORTED when the row is missing a capability', async () => {
    mockFindFirst.mockResolvedValue({ capabilities: ['chat', 'vision'] });
    await expect(
      assertModelSupportsAttachments('openai', 'gpt-4o', ['vision', 'documents'])
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_SUPPORTED',
      retriable: false,
    });
  });

  it('throws CAPABILITY_NOT_SUPPORTED when no matching row exists in the matrix', async () => {
    mockFindFirst.mockResolvedValue(null);
    await expect(
      assertModelSupportsAttachments('openai', 'unknown-model', ['vision'])
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("doesn't throw on partial matches — every required cap must be present", async () => {
    mockFindFirst.mockResolvedValue({ capabilities: ['chat'] });
    await expect(
      assertModelSupportsAttachments('openai', 'gpt-3.5-turbo', ['vision'])
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED' });
  });

  it('mentions the missing capabilities in the error message', async () => {
    mockFindFirst.mockResolvedValue({ capabilities: ['chat'] });
    try {
      await assertModelSupportsAttachments('openai', 'gpt-4o', ['vision', 'documents']);
      throw new Error('Expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).message).toMatch(/vision/);
      expect((err as ProviderError).message).toMatch(/documents/);
    }
  });
});

describe('hasModelWithCapability', () => {
  it('returns true when at least one row carries the capability', async () => {
    mockCount.mockResolvedValue(3);
    expect(await hasModelWithCapability('vision')).toBe(true);
    expect(mockCount).toHaveBeenCalledWith({
      where: {
        isActive: true,
        capabilities: { has: 'vision' },
      },
    });
  });

  it('returns false when no rows carry the capability', async () => {
    mockCount.mockResolvedValue(0);
    expect(await hasModelWithCapability('documents')).toBe(false);
  });
});
