/**
 * Tests: the user's own known values for the privacy scope (§127).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { user: { findUnique: vi.fn() } } }));

import { prisma } from '@/lib/db/client';
import { userKnownValues } from '@/lib/orchestration/privacy/known-values';

beforeEach(() => vi.clearAllMocks());

describe('userKnownValues', () => {
  it("gives the user's name and email, reading only those columns", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      name: '  Ada Lovelace ',
      email: 'ada@example.com',
    } as never);
    await expect(userKnownValues('user-1')()).resolves.toEqual([
      { type: 'PERSON', value: 'Ada Lovelace' },
      { type: 'EMAIL', value: 'ada@example.com' },
    ]);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { name: true, email: true },
    });
  });

  it('reads nothing until it is asked', () => {
    userKnownValues('user-1');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('gives nothing for an embed visitor, without a query', async () => {
    await expect(userKnownValues('embed_visitor-abc')()).resolves.toEqual([]);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('gives nothing for a user who is gone, and skips a blank name', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    await expect(userKnownValues('gone')()).resolves.toEqual([]);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      name: '  ',
      email: 'x@example.com',
    } as never);
    await expect(userKnownValues('u')()).resolves.toEqual([
      { type: 'EMAIL', value: 'x@example.com' },
    ]);
  });
});
