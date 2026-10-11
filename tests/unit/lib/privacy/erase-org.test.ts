/**
 * Tests: lib/privacy/erase-org.ts (§106 t-672)
 *
 * The three things the transaction must do, in order, and the two it must
 * refuse. The cascade (memberships, credentials) is the schema's and is
 * proven by `smoke:tenancy`; here the org delete is asserted and the user
 * table is asserted UNTOUCHED — that is ruling a, and a delete on it would
 * be the accident the docblock rules out.
 *
 * And the storage sweep (§109 t-736): the org's prefix is deleted only after
 * the transaction commits, and a sweep failure is reported, never thrown.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const tx = vi.hoisted(() => ({
  org: { findUnique: vi.fn(), delete: vi.fn() },
  verification: { deleteMany: vi.fn() },
  session: { updateMany: vi.fn() },
  user: { delete: vi.fn(), deleteMany: vi.fn() },
  orgMembership: { deleteMany: vi.fn() },
}));
const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const storage = vi.hoisted(() => ({
  isStorageEnabled: vi.fn(),
  deleteByPrefix: vi.fn(),
}));
vi.mock('@/lib/storage/upload', () => storage);

import { eraseOrg } from '@/lib/privacy/erase-org';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';

const ORG = 'cmorg000000000000000other';
const ADMIN = 'cmjbv4i3x00003wsloputgwul';

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  tx.org.findUnique.mockResolvedValue({ id: ORG, _count: { memberships: 3 } });
  tx.verification.deleteMany.mockResolvedValue({ count: 2 });
  tx.session.updateMany.mockResolvedValue({ count: 4 });
  tx.org.delete.mockResolvedValue({ id: ORG });
  storage.isStorageEnabled.mockReturnValue(true);
  storage.deleteByPrefix.mockResolvedValue({ success: true, key: `orgs/${ORG}/` });
});

describe('eraseOrg', () => {
  it('deletes the pending invitations, clears the session pointer, deletes the org — in one transaction', async () => {
    const result = await eraseOrg({ orgId: ORG, actorUserId: ADMIN });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.verification.deleteMany).toHaveBeenCalledWith({
      where: {
        identifier: { startsWith: 'invitation:' },
        metadata: { path: ['orgId'], equals: ORG },
      },
    });
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { activeOrgId: ORG },
      data: { activeOrgId: null },
    });
    expect(tx.org.delete).toHaveBeenCalledWith({ where: { id: ORG } });

    // Order: the pointer is cleared before the row it names goes.
    const order = [
      tx.verification.deleteMany.mock.invocationCallOrder[0],
      tx.session.updateMany.mock.invocationCallOrder[0],
      tx.org.delete.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(result).toEqual({
      erasedAt: expect.any(Date),
      members: 3,
      pendingInvitations: 2,
      sessionsCleared: 4,
      storageSwept: true,
    });
  });

  it("deletes the org's storage prefix only after the transaction has committed", async () => {
    let committed = false;
    db.$transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => {
      const out = await fn(tx);
      committed = true;
      return out;
    });
    let committedAtSweep: boolean | undefined;
    storage.deleteByPrefix.mockImplementation(() => {
      committedAtSweep = committed;
      return Promise.resolve({ success: true, key: `orgs/${ORG}/` });
    });

    await eraseOrg({ orgId: ORG, actorUserId: ADMIN });

    expect(storage.deleteByPrefix).toHaveBeenCalledTimes(1);
    expect(storage.deleteByPrefix).toHaveBeenCalledWith(`orgs/${ORG}/`);
    expect(committedAtSweep).toBe(true);
  });

  it('does not touch storage when the transaction fails', async () => {
    tx.org.delete.mockRejectedValue(new Error('FK'));
    await expect(eraseOrg({ orgId: ORG, actorUserId: ADMIN })).rejects.toThrow('FK');
    expect(storage.deleteByPrefix).not.toHaveBeenCalled();
  });

  it('reports storageSwept false, and still resolves, when the provider reports failure', async () => {
    storage.deleteByPrefix.mockResolvedValue({ success: false, key: `orgs/${ORG}/` });
    const result = await eraseOrg({ orgId: ORG, actorUserId: ADMIN });
    expect(result.storageSwept).toBe(false);
    expect(tx.org.delete).toHaveBeenCalled();
  });

  it('reports storageSwept false and logs, rather than throwing, when the sweep throws', async () => {
    storage.deleteByPrefix.mockRejectedValue(new Error('bucket unreachable'));
    const result = await eraseOrg({ orgId: ORG, actorUserId: ADMIN });
    expect(result.storageSwept).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Org erased, but deleting its storage prefix failed',
      expect.any(Error),
      { orgId: ORG }
    );
  });

  it('reports storageSwept null and makes no storage call when storage is not configured', async () => {
    storage.isStorageEnabled.mockReturnValue(false);
    const result = await eraseOrg({ orgId: ORG, actorUserId: ADMIN });
    expect(result.storageSwept).toBeNull();
    expect(storage.deleteByPrefix).not.toHaveBeenCalled();
  });

  it('never deletes a user (ruling a)', async () => {
    await eraseOrg({ orgId: ORG, actorUserId: ADMIN });
    expect(tx.user.delete).not.toHaveBeenCalled();
    expect(tx.user.deleteMany).not.toHaveBeenCalled();
    // Memberships are the cascade's, not an explicit delete here.
    expect(tx.orgMembership.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses the install org before opening a transaction (ruling b)', async () => {
    await expect(eraseOrg({ orgId: INSTALL_ORG_ID, actorUserId: ADMIN })).rejects.toMatchObject({
      code: 'INSTALL_ORG_IMMUTABLE',
      status: 400,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('is a 404 for an org that does not exist, and writes nothing', async () => {
    tx.org.findUnique.mockResolvedValue(null);
    const error = await eraseOrg({ orgId: ORG, actorUserId: ADMIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgLifecycleError);
    expect((error as OrgLifecycleError).code).toBe('ORG_NOT_FOUND');
    expect(tx.verification.deleteMany).not.toHaveBeenCalled();
    expect(tx.org.delete).not.toHaveBeenCalled();
  });

  it('propagates a failure inside the transaction so nothing is half-erased', async () => {
    tx.org.delete.mockRejectedValue(new Error('FK'));
    await expect(eraseOrg({ orgId: ORG, actorUserId: ADMIN })).rejects.toThrow('FK');
    expect(mockLogger.info).not.toHaveBeenCalledWith('Org erased', expect.anything());
  });

  it('logs the actor and the counts', async () => {
    await eraseOrg({ orgId: ORG, actorUserId: ADMIN });
    expect(mockLogger.info).toHaveBeenCalledWith('Org erased', {
      orgId: ORG,
      actorUserId: ADMIN,
      members: 3,
      pendingInvitations: 2,
      sessionsCleared: 4,
      storageSwept: true,
    });
  });
});
