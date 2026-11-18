/**
 * Tests: what a data subject receives about an org's own AI key they saved
 * (§137 t-1044) — that they saved it, for which org and provider, and when.
 * Never the key, its envelope or its hint: the key is the org's, not theirs.
 *
 * @see lib/privacy/export-sources.ts — the `AiOrgProviderKey` source
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { aiOrgProviderKey: { findMany: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { SUBJECT_DATA_SOURCES } from '@/lib/privacy/export-sources';

const source = SUBJECT_DATA_SOURCES.find((s) => s.model === 'AiOrgProviderKey');

describe('the AiOrgProviderKey subject-export source', () => {
  it('is an attribution, and asks for no part of the key', async () => {
    const savedAt = new Date('2026-11-18T10:00:00Z');
    vi.mocked(prisma.aiOrgProviderKey.findMany).mockResolvedValue([
      {
        id: 'key1',
        savedAt,
        providerConfig: { name: 'Anthropic' },
        org: { name: 'Acme' },
      },
    ] as never);

    expect(source?.disposition).toBe('attribution');
    const rows = await source!.fetch({ userId: 'user-1' } as never);

    const [args] = vi.mocked(prisma.aiOrgProviderKey.findMany).mock.calls[0] as [
      { where: unknown; select: Record<string, unknown> },
    ];
    expect(args.where).toEqual({ savedById: 'user-1' });
    expect(Object.keys(args.select).sort()).toEqual(['id', 'org', 'providerConfig', 'savedAt']);
    expect(rows).toEqual([
      { id: 'key1', label: "Saved Acme's key for Anthropic", createdAt: savedAt },
    ]);
  });
});
