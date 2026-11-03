/**
 * Tests: a user's own API keys, the parts no route reaches (#1132)
 *
 * The routes' tests cover list, mint and revoke at both tenancy modes. These
 * pin the store's own rules: only an `admin` key may bind no org, and at
 * `single` each operation is the one query it always was, with no system
 * scope entered.
 *
 * @see lib/auth/user-api-keys.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiApiKey: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
  },
}));

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { listUserApiKeys, mintUserApiKey, revokeUserApiKey } from '@/lib/auth/user-api-keys';
import { runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const base = {
  userId: 'u1',
  name: 'k',
  keyHash: 'h',
  keyPrefix: 'sk_x',
  expiresAt: null,
};

describe('user API key store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TENANCY_MODE = 'single';
  });

  it.each(['single', 'multi'])(
    'refuses to mint a non-admin key with no org at %s, writing nothing',
    async (mode) => {
      // The state the §106 backfill removed: a key no org's policy can see.
      mockEnv.TENANCY_MODE = mode;
      await expect(mintUserApiKey({ ...base, scopes: ['chat'], orgId: null })).rejects.toThrow(
        'Only an admin-scoped key may be minted without an org'
      );
      expect(prisma.aiApiKey.create).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused before any write
    }
  );

  it('lists with one query at single, entering no system scope', async () => {
    vi.mocked(prisma.aiApiKey.findMany).mockResolvedValue([]);

    await listUserApiKeys('u1');

    expect(prisma.aiApiKey.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.aiApiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' }, orderBy: { createdAt: 'desc' } })
    );
    expect(logger.info).not.toHaveBeenCalledWith('Entering system tenant scope', expect.anything());
  });

  it('mints an admin key at single without entering the system scope', async () => {
    vi.mocked(prisma.aiApiKey.create).mockResolvedValue({ id: 'k1' } as never);

    await mintUserApiKey({ ...base, scopes: ['admin'], orgId: null });

    expect(prisma.aiApiKey.create).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalledWith('Entering system tenant scope', expect.anything());
  });

  it('revokes with one conditional write at single', async () => {
    vi.mocked(prisma.aiApiKey.updateMany).mockResolvedValue({ count: 1 });

    expect(await revokeUserApiKey('u1', 'k1')).toBe('revoked');
    expect(prisma.aiApiKey.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.aiApiKey.updateMany).toHaveBeenCalledWith({
      where: { id: 'k1', userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.aiApiKey.findFirst).not.toHaveBeenCalled(); // test-review:accept no_arg_called — a matched write needs no read
  });

  describe('at multi', () => {
    beforeEach(() => {
      mockEnv.TENANCY_MODE = 'multi';
    });

    it('lists no platform key to an API key, even one bound to the install org', async () => {
      // A leaked narrow key bound there must not list its owner's admin keys.
      vi.mocked(prisma.aiApiKey.findMany).mockResolvedValue([]);

      await runAsOrg(INSTALL_ORG_ID, () => listUserApiKeys('u1'), { source: 'api-key' });

      expect(prisma.aiApiKey.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.aiApiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', orgId: { not: null } } })
      );
    });

    it('lists platform keys to a browser session in the install org', async () => {
      vi.mocked(prisma.aiApiKey.findMany).mockResolvedValue([]);

      await runAsOrg(INSTALL_ORG_ID, () => listUserApiKeys('u1'), { source: 'session' });

      expect(prisma.aiApiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', orgId: null } })
      );
    });

    it('answers an empty list, not a refusal, when no org was entered (an admin key)', async () => {
      // Every tenant-owned read throws without a context at multi; with no
      // org there is no org-bound key to list, and a key manages no platform key.
      await expect(listUserApiKeys('u1')).resolves.toEqual([]);
      expect(prisma.aiApiKey.findMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to read with no org entered
    });

    it('answers not found for a revoke with no org entered, touching nothing', async () => {
      await expect(revokeUserApiKey('u1', 'k1')).resolves.toBe('not-found');
      expect(prisma.aiApiKey.updateMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to reach with no org entered
    });

    it('passes only the known fields to the database on mint', async () => {
      vi.mocked(prisma.aiApiKey.create).mockResolvedValue({ id: 'k1' } as never);
      const wider = { ...base, scopes: ['chat'], orgId: 'org-a', role: 'ADMIN' };

      await runAsOrg('org-a', () => mintUserApiKey(wider), { source: 'session' });

      expect(prisma.aiApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { ...base, scopes: ['chat'], orgId: 'org-a' } })
      );
    });
  });
});
