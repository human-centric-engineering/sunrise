/**
 * Tests: lib/tenancy/support-grants.ts — an org's consent to vendor support
 * (§121 t-823)
 *
 * Each rule is written so the wrong behaviour fails it. The owner rule is
 * tested against the callers most likely to slip through: an ADMIN of the
 * org, an OWNER of a *different* org, and a platform admin acting in the
 * install org (whose install-org role is OWNER). Each refusal asserts that
 * nothing was written. Replacement is shown to revoke the open grant inside
 * the same transaction as the create.
 *
 * Prisma is a double at the delegate level; `$transaction` hands the same
 * double back as the transaction client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { SUPPORT_GRANT_DEFAULT_HOURS } from '@/lib/validations/tenancy';

const db = vi.hoisted(() => ({
  org: { findUnique: vi.fn() },
  orgSupportGrant: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const multi = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/tenancy/context', () => ({ isMultiTenant: () => multi.on }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  findOpenSupportGrant,
  grantSupportAccess,
  listSupportGrants,
  openSupportGrantWhere,
  revokeSupportGrant,
  supportGrantActorOf,
  SupportGrantError,
  SUPPORT_GRANT_LIST_LIMIT,
} from '@/lib/tenancy/support-grants';
import { APIError } from '@/lib/api/errors';

const ORG = 'cmorg000000000000000other';
const ELSEWHERE = 'cmorg00000000000000elsewh';
const OWNER_ID = 'cmjbv4i3x00003wsloputgwul';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const AS_OWNER = { userId: OWNER_ID, orgId: ORG, orgRole: ORG_OWNER_ROLE };

const grantRow = (
  over: Partial<{ id: string; expiresAt: Date; revokedAt: Date | null; level: string }> = {}
) => ({
  id: 'cmgrant00000000000000one',
  orgId: ORG,
  level: 'ADMIN',
  reason: 'Ticket 42: the triage agent stopped answering',
  expiresAt: new Date(NOW.getTime() + 24 * HOUR),
  createdAt: NOW,
  revokedAt: null,
  grantedBy: { id: OWNER_ID, name: 'Olive Owner' },
  revokedBy: null,
  ...over,
});

async function refusal(fn: () => Promise<unknown>): Promise<SupportGrantError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SupportGrantError) return err;
    throw err;
  }
  throw new Error('expected a SupportGrantError, got none');
}

beforeEach(() => {
  vi.clearAllMocks();
  multi.on = true;
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  db.org.findUnique.mockResolvedValue({ status: 'ACTIVE' });
  db.orgSupportGrant.findMany.mockResolvedValue([]);
  db.orgSupportGrant.create.mockImplementation(
    async ({ data }: { data: { level: string; reason: string; expiresAt: Date } }) =>
      grantRow({ level: data.level, expiresAt: data.expiresAt })
  );
});

describe('openSupportGrantWhere', () => {
  it('is not revoked and not yet expired, at the given instant', () => {
    expect(openSupportGrantWhere(NOW)).toEqual({ revokedAt: null, expiresAt: { gt: NOW } });
  });
});

describe('supportGrantActorOf', () => {
  it('reads the user and the verified org and role off the principal, never the platform role', () => {
    const actor = supportGrantActorOf({
      user: { id: OWNER_ID },
      principal: { orgId: ORG, orgRole: ORG_OWNER_ROLE },
    });
    expect(actor).toEqual({ userId: OWNER_ID, orgId: ORG, orgRole: ORG_OWNER_ROLE });
    expect(actor).not.toHaveProperty('platformAdmin');
  });
});

describe('grantSupportAccess', () => {
  it('creates an ADMIN grant for the default duration when the owner names neither', async () => {
    const { grant, replacedGrantIds } = await grantSupportAccess(
      ORG,
      { reason: 'Ticket 42' },
      AS_OWNER,
      db as never,
      NOW
    );

    expect(db.orgSupportGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          orgId: ORG,
          level: 'ADMIN',
          reason: 'Ticket 42',
          expiresAt: new Date(NOW.getTime() + SUPPORT_GRANT_DEFAULT_HOURS * HOUR),
          grantedById: OWNER_ID,
        },
      })
    );
    expect(grant.open).toBe(true);
    expect(replacedGrantIds).toEqual([]);
    expect(db.orgSupportGrant.updateMany).not.toHaveBeenCalled();
  });

  it('takes the level and duration the owner chose', async () => {
    await grantSupportAccess(
      ORG,
      { reason: 'Look only', level: 'READ_ONLY', durationHours: 4 },
      AS_OWNER,
      db as never,
      NOW
    );
    expect(db.orgSupportGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          level: 'READ_ONLY',
          expiresAt: new Date(NOW.getTime() + 4 * HOUR),
        }),
      })
    );
  });

  it('replaces the open grant: revokes it as the granter, in the same serializable transaction', async () => {
    db.orgSupportGrant.findMany.mockResolvedValue([{ id: 'cmgrant0000000000000older' }]);
    const order: string[] = [];
    db.orgSupportGrant.updateMany.mockImplementation(async () => {
      order.push('revoke');
      return { count: 1 };
    });
    db.orgSupportGrant.create.mockImplementation(async () => {
      order.push('create');
      return grantRow();
    });

    const { replacedGrantIds } = await grantSupportAccess(
      ORG,
      { reason: 'New ticket' },
      AS_OWNER,
      db as never,
      NOW
    );

    expect(replacedGrantIds).toEqual(['cmgrant0000000000000older']);
    expect(db.orgSupportGrant.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG, revokedAt: null, expiresAt: { gt: NOW } },
      select: { id: true },
    });
    expect(db.orgSupportGrant.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['cmgrant0000000000000older'] } },
      data: { revokedAt: NOW, revokedById: OWNER_ID },
    });
    expect(order).toEqual(['revoke', 'create']);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('returns every open grant it revoked, so each replacement can be audited', async () => {
    // At most one should be open; if the invariant was ever broken, all are
    // revoked and all are reported, not just the first.
    db.orgSupportGrant.findMany.mockResolvedValue([
      { id: 'cmgrant0000000000000older' },
      { id: 'cmgrant000000000000oldest' },
    ]);
    db.orgSupportGrant.updateMany.mockResolvedValue({ count: 2 });

    const { replacedGrantIds } = await grantSupportAccess(
      ORG,
      { reason: 'New ticket' },
      AS_OWNER,
      db as never,
      NOW
    );

    expect(replacedGrantIds).toEqual(['cmgrant0000000000000older', 'cmgrant000000000000oldest']);
  });

  it('answers a clash with a concurrent grant as a 409 GRANT_CONFLICT', async () => {
    db.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('could not serialize access', {
        code: 'P2034',
        clientVersion: 'test',
      })
    );
    const err = await refusal(() =>
      grantSupportAccess(ORG, { reason: 'x' }, AS_OWNER, db as never, NOW)
    );
    expect(err.code).toBe('GRANT_CONFLICT');
    expect(err.status).toBe(409);
  });

  it('lets any other transaction failure through unchanged', async () => {
    const boom = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    db.$transaction.mockRejectedValue(boom);
    await expect(grantSupportAccess(ORG, { reason: 'x' }, AS_OWNER, db as never, NOW)).rejects.toBe(
      boom
    );
  });

  describe('refuses, and writes nothing', () => {
    const expectNoWrite = () => {
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.orgSupportGrant.create).not.toHaveBeenCalled();
      expect(db.orgSupportGrant.updateMany).not.toHaveBeenCalled();
    };

    it('at single', async () => {
      multi.on = false;
      const err = await refusal(() =>
        grantSupportAccess(ORG, { reason: 'x' }, AS_OWNER, db as never, NOW)
      );
      expect(err.code).toBe('SUPPORT_NOT_AVAILABLE');
      expect(err.status).toBe(400);
      expectNoWrite();
    });

    it('for the install org, even from its OWNER', async () => {
      const err = await refusal(() =>
        grantSupportAccess(
          INSTALL_ORG_ID,
          { reason: 'x' },
          { userId: OWNER_ID, orgId: INSTALL_ORG_ID, orgRole: ORG_OWNER_ROLE },
          db as never,
          NOW
        )
      );
      expect(err.code).toBe('INSTALL_ORG');
      expectNoWrite();
    });

    it('for an ADMIN of the org', async () => {
      const err = await refusal(() =>
        grantSupportAccess(
          ORG,
          { reason: 'x' },
          { userId: OWNER_ID, orgId: ORG, orgRole: ORG_ADMIN_ROLE },
          db as never,
          NOW
        )
      );
      expect(err.code).toBe('OWNER_REQUIRED');
      expect(err.status).toBe(403);
      expectNoWrite();
    });

    it('for an OWNER acting in another org — a platform admin in the install org is one', async () => {
      // A platform admin's install-org role is OWNER, and the policy admits
      // them to this org's routes from there. Their role there is not
      // standing here.
      const err = await refusal(() =>
        grantSupportAccess(
          ORG,
          { reason: 'x' },
          { userId: OWNER_ID, orgId: INSTALL_ORG_ID, orgRole: ORG_OWNER_ROLE },
          db as never,
          NOW
        )
      );
      expect(err.code).toBe('OWNER_REQUIRED');

      const elsewhere = await refusal(() =>
        grantSupportAccess(
          ORG,
          { reason: 'x' },
          { userId: OWNER_ID, orgId: ELSEWHERE, orgRole: ORG_OWNER_ROLE },
          db as never,
          NOW
        )
      );
      expect(elsewhere.code).toBe('OWNER_REQUIRED');
      expectNoWrite();
    });

    // The org's status is read inside the transaction, so these two reach
    // it; what they must not do is write.
    const expectNoGrantWrite = () => {
      expect(db.orgSupportGrant.create).not.toHaveBeenCalled();
      expect(db.orgSupportGrant.updateMany).not.toHaveBeenCalled();
    };

    it('for an org that does not exist', async () => {
      db.org.findUnique.mockResolvedValue(null);
      const err = await refusal(() =>
        grantSupportAccess(ORG, { reason: 'x' }, AS_OWNER, db as never, NOW)
      );
      expect(err.code).toBe('ORG_NOT_FOUND');
      expect(err.status).toBe(404);
      expectNoGrantWrite();
    });

    it('for a suspended org', async () => {
      db.org.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
      const err = await refusal(() =>
        grantSupportAccess(ORG, { reason: 'x' }, AS_OWNER, db as never, NOW)
      );
      expect(err.code).toBe('ORG_NOT_ACTIVE');
      expectNoGrantWrite();
    });

    it('for an org suspended as the transaction began: the status is read inside it', async () => {
      // Outside the transaction the org still reads ACTIVE; the transaction's
      // own client sees the committed suspension. Only an in-transaction read
      // refuses.
      db.org.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      const tx = {
        org: { findUnique: vi.fn().mockResolvedValue({ status: 'SUSPENDED' }) },
        orgSupportGrant: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
      };
      db.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));

      const err = await refusal(() =>
        grantSupportAccess(ORG, { reason: 'x' }, AS_OWNER, db as never, NOW)
      );

      expect(err.code).toBe('ORG_NOT_ACTIVE');
      expect(tx.org.findUnique).toHaveBeenCalledWith({
        where: { id: ORG },
        select: { status: true },
      });
      expect(tx.orgSupportGrant.create).not.toHaveBeenCalled();
      expect(tx.orgSupportGrant.updateMany).not.toHaveBeenCalled();
    });
  });

  it('refuses as an APIError, so a route can let it propagate', async () => {
    multi.on = false;
    const err = await refusal(() =>
      grantSupportAccess(ORG, { reason: 'x' }, AS_OWNER, db as never, NOW)
    );
    expect(err).toBeInstanceOf(APIError);
  });
});

describe('revokeSupportGrant', () => {
  it('ends an open grant now, conditional on it still being open and this org’s', async () => {
    db.orgSupportGrant.updateMany.mockResolvedValue({ count: 1 });
    db.orgSupportGrant.findFirst.mockResolvedValue(
      grantRow({ revokedAt: NOW, expiresAt: new Date(NOW.getTime() + HOUR) })
    );

    const { grant, revoked } = await revokeSupportGrant(
      ORG,
      'cmgrant00000000000000one',
      { userId: OWNER_ID },
      db as never,
      NOW
    );

    expect(db.orgSupportGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'cmgrant00000000000000one',
        orgId: ORG,
        revokedAt: null,
        expiresAt: { gt: NOW },
      },
      data: { revokedAt: NOW, revokedById: OWNER_ID },
    });
    expect(revoked).toBe(true);
    expect(grant.open).toBe(false);
  });

  it('answers an already-ended grant as it is, reporting nothing revoked', async () => {
    db.orgSupportGrant.updateMany.mockResolvedValue({ count: 0 });
    db.orgSupportGrant.findFirst.mockResolvedValue(
      grantRow({ expiresAt: new Date(NOW.getTime() - HOUR) })
    );

    const { grant, revoked } = await revokeSupportGrant(
      ORG,
      'cmgrant00000000000000one',
      { userId: OWNER_ID },
      db as never,
      NOW
    );
    expect(revoked).toBe(false);
    expect(grant.open).toBe(false);
  });

  it('does not find another org’s grant', async () => {
    db.orgSupportGrant.updateMany.mockResolvedValue({ count: 0 });
    db.orgSupportGrant.findFirst.mockResolvedValue(null);

    const err = await refusal(() =>
      revokeSupportGrant(ORG, 'cmgrant00000000000000one', { userId: OWNER_ID }, db as never, NOW)
    );
    expect(err.code).toBe('GRANT_NOT_FOUND');
    expect(err.status).toBe(404);
    expect(db.orgSupportGrant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cmgrant00000000000000one', orgId: ORG } })
    );
  });
});

describe('reads', () => {
  it('findOpenSupportGrant asks for this org’s open grant', async () => {
    db.orgSupportGrant.findFirst.mockResolvedValue(grantRow());
    const grant = await findOpenSupportGrant(ORG, db as never, NOW);
    expect(db.orgSupportGrant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: ORG, revokedAt: null, expiresAt: { gt: NOW } } })
    );
    expect(grant?.open).toBe(true);
  });

  it('findOpenSupportGrant is null when there is none', async () => {
    db.orgSupportGrant.findFirst.mockResolvedValue(null);
    expect(await findOpenSupportGrant(ORG, db as never, NOW)).toBeNull();
  });

  it('listSupportGrants returns this org’s grants newest first, each marked open or not', async () => {
    db.orgSupportGrant.findMany.mockResolvedValue([
      grantRow({ id: 'cmgrant0000000000000newer' }),
      grantRow({ id: 'cmgrant0000000000000revkd', revokedAt: new Date(NOW.getTime() - HOUR) }),
      grantRow({ id: 'cmgrant0000000000000expir', expiresAt: new Date(NOW.getTime() - HOUR) }),
    ]);

    const grants = await listSupportGrants(ORG, db as never, NOW);

    expect(db.orgSupportGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: ORG },
        orderBy: { createdAt: 'desc' },
        take: SUPPORT_GRANT_LIST_LIMIT,
      })
    );
    expect(grants.map((g) => [g.id, g.open])).toEqual([
      ['cmgrant0000000000000newer', true],
      ['cmgrant0000000000000revkd', false],
      ['cmgrant0000000000000expir', false],
    ]);
  });
});
