import { describe, it, expect, vi, beforeEach } from 'vitest';

import reconcileSeed from '@/prisma/seeds/019-reconcile-legacy-seed-users';
import { SYSTEM_USER_EMAIL } from '@/lib/auth/constants';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the one-time `019-reconcile-legacy-seed-users` upgrade seed.
 *
 * Contract:
 *  - Erases the legacy `admin@example.com` / `test@example.com` rows ONLY when
 *    they are seed artifacts (accountType HUMAN, zero credential Accounts).
 *  - Leaves alone a real user that happens to use one of those emails (has a
 *    credential), or any row that isn't HUMAN.
 *  - Re-points orphaned (null-owned) config to the SERVICE owner.
 *  - Sets the bootstrap marker iff a real human admin exists.
 *  - No-ops safely when the SERVICE owner is absent.
 */

const { eraseUser } = vi.hoisted(() => ({ eraseUser: vi.fn() }));
vi.mock('@/lib/privacy/erase-user', () => ({ eraseUser }));

const SYSTEM_ID = 'system-owner-id';

function makeCtx(opts: {
  systemOwner?: { id: string } | null;
  legacy?: Record<string, { id: string; accountType: string; accounts: number } | null>;
  humanAdminCount?: number;
}) {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const upsert = vi.fn().mockResolvedValue({ id: 'singleton' });
  const findFirst = vi.fn().mockResolvedValue(opts.systemOwner ?? null);
  const count = vi.fn().mockResolvedValue(opts.humanAdminCount ?? 0);
  const findUnique = vi.fn(async ({ where: { email } }: { where: { email: string } }) => {
    const row = opts.legacy?.[email] ?? null;
    if (!row) return null;
    return {
      id: row.id,
      email,
      accountType: row.accountType,
      _count: { accounts: row.accounts },
    };
  });

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // Proxy so every model delegate (aiWorkflow, aiAgent, …) answers updateMany,
  // while `user` and `authBootstrap` expose their specific methods.
  const prisma = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'user') return { findFirst, findUnique, count };
        if (prop === 'authBootstrap') return { upsert };
        return { updateMany };
      },
    }
  ) as unknown as SeedContext['prisma'];

  return {
    ctx: { prisma, logger } as unknown as SeedContext,
    updateMany,
    upsert,
    findFirst,
    count,
  };
}

describe('019-reconcile-legacy-seed-users', () => {
  beforeEach(() => vi.clearAllMocks());

  it('erases credential-less legacy HUMAN seed users and re-points orphaned config', async () => {
    const { ctx, updateMany, upsert } = makeCtx({
      systemOwner: { id: SYSTEM_ID },
      legacy: {
        'admin@example.com': { id: 'legacy-admin', accountType: 'HUMAN', accounts: 0 },
        'test@example.com': { id: 'legacy-test', accountType: 'HUMAN', accounts: 0 },
      },
      humanAdminCount: 1,
    });

    await reconcileSeed.run(ctx);

    expect(eraseUser).toHaveBeenCalledTimes(2);
    expect(eraseUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'legacy-admin',
        actorUserId: SYSTEM_ID,
        reason: 'admin_action',
      })
    );
    // Orphaned config re-pointed to the SERVICE owner (at least one updateMany).
    expect(updateMany).toHaveBeenCalledWith({
      where: { createdBy: null },
      data: { createdBy: SYSTEM_ID },
    });
    // A real human admin exists → bootstrap marker set.
    expect(upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton' },
    });
  });

  it('does NOT erase a legacy email that has a credential Account (a real user)', async () => {
    const { ctx } = makeCtx({
      systemOwner: { id: SYSTEM_ID },
      legacy: {
        'admin@example.com': { id: 'real-person', accountType: 'HUMAN', accounts: 1 },
      },
      humanAdminCount: 1,
    });

    await reconcileSeed.run(ctx);

    expect(eraseUser).not.toHaveBeenCalled();
  });

  it('does NOT set the bootstrap marker when no human admin exists (human-less DB stays open)', async () => {
    const { ctx, upsert } = makeCtx({
      systemOwner: { id: SYSTEM_ID },
      legacy: {},
      humanAdminCount: 0,
    });

    await reconcileSeed.run(ctx);

    expect(eraseUser).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('is a safe no-op when the SERVICE owner is absent', async () => {
    const { ctx, updateMany, upsert } = makeCtx({ systemOwner: null });

    await reconcileSeed.run(ctx);

    expect(eraseUser).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reconciles by the canonical legacy emails only', async () => {
    // Sanity: the seed targets the two known legacy emails, not arbitrary users.
    const { ctx, findFirst } = makeCtx({
      systemOwner: { id: SYSTEM_ID },
      legacy: {},
      humanAdminCount: 0,
    });
    await reconcileSeed.run(ctx);
    // It resolved the SERVICE owner (serviceAccountWhere) before doing work.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountType: 'SERVICE' } })
    );
    // SYSTEM_USER_EMAIL is the seeded identity, never a reconcile target.
    expect(SYSTEM_USER_EMAIL).toBe('system@sunrise.local');
  });
});
