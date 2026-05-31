import { describe, it, expect, vi } from 'vitest';

import systemOwnerSeed from '@/prisma/seeds/001-system-owner';
import { SYSTEM_USER_EMAIL } from '@/lib/auth/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `001-system-owner` seed (issue #278).
 *
 * The contract this seed must hold:
 *  - it provisions exactly ONE user, the non-login config-owner;
 *  - that user has role `ADMIN` and the canonical `SYSTEM_USER_EMAIL`, so the
 *    downstream orchestration seeds (which resolve an `ADMIN` owner) succeed;
 *  - it creates NO credential `Account` — the account can never log in, which
 *    is the whole point (a seeded credential cannot validate against
 *    better-auth's scrypt hashing);
 *  - the write is an idempotent `upsert` with `update: {}` so re-seeding never
 *    clobbers operator edits.
 */

function makeCtx() {
  const upsert = vi.fn().mockResolvedValue({ email: SYSTEM_USER_EMAIL });
  const accountCreate = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: {
      user: { upsert },
      account: { create: accountCreate },
    },
    logger,
  } as unknown as SeedContext;

  return { ctx, upsert, accountCreate, logger };
}

describe('001-system-owner seed', () => {
  it('upserts a single ADMIN config-owner with the canonical system email', async () => {
    const { ctx, upsert } = makeCtx();

    await systemOwnerSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      where: { email: SYSTEM_USER_EMAIL },
      // `update` heals an existing row to role ADMIN + SERVICE on re-seed.
      update: { role: 'ADMIN', accountType: 'SERVICE' },
      create: {
        email: SYSTEM_USER_EMAIL,
        name: 'System (config owner)',
        emailVerified: true,
        role: 'ADMIN',
        accountType: 'SERVICE',
      },
    });
  });

  it('creates NO credential Account (the system owner cannot log in)', async () => {
    const { ctx, accountCreate } = makeCtx();

    await systemOwnerSeed.run(ctx);

    expect(accountCreate).not.toHaveBeenCalled();
  });

  it('marks the owner as a SERVICE account on both create and update', async () => {
    const { ctx, upsert } = makeCtx();

    await systemOwnerSeed.run(ctx);

    const arg = upsert.mock.calls[0][0];
    expect(arg.create.accountType).toBe('SERVICE');
    expect(arg.update.accountType).toBe('SERVICE');
  });

  it('declares the expected seed unit name', () => {
    expect(systemOwnerSeed.name).toBe('001-system-owner');
  });
});
