/**
 * Unit tests: eraseWaitlistEntry() (§125 t-975)
 *
 * What the erasure writes, and — by handing the receipt it wrote to the real
 * `matchErasedSubjects()` — what the recipient writers then make of it. The
 * CHECK that pairs `subjectKind` with `subjectUserId` is a Postgres property:
 * `smoke:erasure` holds it, and that `findErasedSubjects()` does not refuse
 * the address on a real receipt.
 *
 * @see lib/waitlist/erase.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const mockTx = {
    waitlistEntry: { findUnique: vi.fn(), deleteMany: vi.fn() },
    dataErasureReceipt: { create: vi.fn() },
    verification: { findMany: vi.fn(), deleteMany: vi.fn() },
  };
  return {
    mockTx,
    mockPrisma: {
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    },
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { eraseWaitlistEntry } from '@/lib/waitlist/erase';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { matchErasedSubjects } from '@/lib/privacy/erased-subjects';

const ERASED_AT = new Date('2026-11-04T10:00:00Z');
const ADDRESS = 'ada@example.com';

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    email: ADDRESS,
    list: 'default',
    confirmedAt: null,
    orgId: 'org-a',
    userId: null,
    ...over,
  };
}

type ReceiptData = {
  subjectKind: string;
  subjectUserId: string | null;
  subjectEmailHash: string;
  actorUserId: string | null;
  reason: string;
  metadata: Prisma.JsonValue;
};

function writtenReceipt(): ReceiptData {
  const [args] = mockTx.dataErasureReceipt.create.mock.calls[0] as [{ data: ReceiptData }];
  return args.data;
}

/**
 * What a recipient writer refuses with `receipt` in the table. The lookup
 * applies the reader's `subjectKind` filter, as Postgres would; the rest of its
 * where (hash, id) matches this receipt by construction.
 */
async function writersRefuse(receipt: ReceiptData) {
  const tx = {
    dataErasureReceipt: {
      findMany: vi.fn(async (args: { where: { subjectKind?: string } }) =>
        [receipt].filter((r) => !args.where.subjectKind || r.subjectKind === args.where.subjectKind)
      ),
    },
    user: { findMany: vi.fn(async () => []) },
  };
  return matchErasedSubjects(tx as never, { addresses: [ADDRESS], userIds: ['u-linked'] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.waitlistEntry.findUnique.mockResolvedValue(entry());
  mockTx.waitlistEntry.deleteMany.mockResolvedValue({ count: 1 });
  mockTx.dataErasureReceipt.create.mockResolvedValue({ id: 'r-1', erasedAt: ERASED_AT });
  mockTx.verification.findMany.mockResolvedValue([]);
  mockTx.verification.deleteMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    })
  );
});

describe('eraseWaitlistEntry', () => {
  it('deletes the entry and writes a waitlist receipt, in one transaction', async () => {
    const result = await eraseWaitlistEntry({
      entryId: 'entry-1',
      actorUserId: null,
      reason: 'self_service',
    });

    expect(result).toEqual({ receiptId: 'r-1', erasedAt: ERASED_AT, invitationsDeleted: 0 });
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockTx.waitlistEntry.deleteMany).toHaveBeenCalledWith({ where: { id: 'entry-1' } });
    expect(writtenReceipt()).toEqual({
      subjectKind: 'waitlist',
      subjectUserId: null,
      subjectEmailHash: createHash('sha256').update(ADDRESS).digest('hex'),
      actorUserId: null,
      reason: 'self_service',
      metadata: {
        addressVerified: false,
        entryConfirmed: false,
        list: 'default',
        orgId: 'org-a',
        linkedUserId: null,
      },
    });
  });

  it('records the admin who erased it, and that the owner had confirmed', async () => {
    mockTx.waitlistEntry.findUnique.mockResolvedValue(
      entry({ confirmedAt: new Date('2026-11-02T00:00:00Z'), list: 'beta' })
    );

    await eraseWaitlistEntry({
      entryId: 'entry-1',
      actorUserId: 'admin-1',
      reason: 'admin_action',
    });

    expect(writtenReceipt()).toMatchObject({
      actorUserId: 'admin-1',
      reason: 'admin_action',
      metadata: { addressVerified: false, entryConfirmed: true, list: 'beta' },
    });
  });

  it('records the account an invitation linked the entry to, and still names none', async () => {
    mockTx.waitlistEntry.findUnique.mockResolvedValue(entry({ userId: 'u-linked' }));

    await eraseWaitlistEntry({
      entryId: 'entry-1',
      actorUserId: 'admin-1',
      reason: 'admin_action',
    });

    expect(writtenReceipt()).toMatchObject({
      subjectUserId: null,
      metadata: { linkedUserId: 'u-linked' },
    });
  });

  it('writes no receipt for an entry it cannot see', async () => {
    mockTx.waitlistEntry.findUnique.mockResolvedValue(null);

    const result = await eraseWaitlistEntry({
      entryId: 'other-org',
      actorUserId: 'admin-1',
      reason: 'admin_action',
    });

    expect(result).toBeNull();
    expect(mockTx.waitlistEntry.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.dataErasureReceipt.create).not.toHaveBeenCalled();
  });

  it('writes no second receipt when a concurrent erasure deleted it first', async () => {
    mockTx.waitlistEntry.deleteMany.mockResolvedValue({ count: 0 });

    const result = await eraseWaitlistEntry({
      entryId: 'entry-1',
      actorUserId: null,
      reason: 'self_service',
    });

    expect(result).toBeNull();
    expect(mockTx.dataErasureReceipt.create).not.toHaveBeenCalled();
  });
});

describe('a pending invitation for the address (spec, Rules carried over)', () => {
  const invitation = (id: string, metadata: unknown) => ({ id, metadata });
  const meta = (orgId?: string) => ({
    name: 'Ada',
    role: 'USER',
    invitedBy: 'admin-1',
    invitedAt: '2026-11-01T00:00:00Z',
    ...(orgId ? { orgId } : {}),
  });

  it('deletes the one this org issued, in the same transaction, and looks it up by the address', async () => {
    mockTx.verification.findMany.mockResolvedValue([invitation('v-1', meta('org-a'))]);

    const result = await eraseWaitlistEntry({
      entryId: 'entry-1',
      actorUserId: 'admin-1',
      reason: 'admin_action',
    });

    expect(mockTx.verification.findMany).toHaveBeenCalledWith({
      where: { identifier: `invitation:${ADDRESS}` },
      select: { id: true, metadata: true },
    });
    expect(mockTx.verification.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['v-1'] } } });
    expect(result?.invitationsDeleted).toBe(1);
  });

  it('reads an invitation naming no org as the install org’s', async () => {
    mockTx.waitlistEntry.findUnique.mockResolvedValue(entry({ orgId: INSTALL_ORG_ID }));
    mockTx.verification.findMany.mockResolvedValue([invitation('v-1', meta())]);

    const result = await eraseWaitlistEntry({
      entryId: 'entry-1',
      actorUserId: null,
      reason: 'self_service',
    });

    expect(result?.invitationsDeleted).toBe(1);
  });

  it('keeps another org’s invitation, and one it cannot read (logged)', async () => {
    mockTx.verification.findMany.mockResolvedValue([
      invitation('v-other', meta('org-b')),
      invitation('v-broken', { not: 'an invitation' }),
    ]);

    const result = await eraseWaitlistEntry({
      entryId: 'entry-1',
      actorUserId: 'admin-1',
      reason: 'admin_action',
    });

    expect(mockTx.verification.deleteMany).not.toHaveBeenCalled();
    expect(result?.invitationsDeleted).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Waitlist erasure left an invitation it could not read',
      { entryId: 'entry-1', count: 1 }
    );
  });
});

describe('what the recipient writers make of the receipt', () => {
  // Decided in t-975: neither is refused. The refusal stops a stale copy
  // putting back what erasure stripped from configuration, and this erasure
  // strips none; refusing would leave configuration that already names the
  // address unsavable.
  it.each([
    ['an unconfirmed entry', null],
    ['a confirmed entry', new Date('2026-11-02T00:00:00Z')],
  ])('does not refuse the address or any account after erasing %s', async (_label, confirmedAt) => {
    mockTx.waitlistEntry.findUnique.mockResolvedValue(entry({ confirmedAt }));
    await eraseWaitlistEntry({ entryId: 'entry-1', actorUserId: null, reason: 'self_service' });

    await expect(writersRefuse(writtenReceipt())).resolves.toEqual({
      addresses: [],
      userIds: [],
    });
  });

  it('is not refused even if it said verified: the readers skip its kind', async () => {
    await eraseWaitlistEntry({ entryId: 'entry-1', actorUserId: null, reason: 'self_service' });
    const receipt = writtenReceipt();

    await expect(
      writersRefuse({ ...receipt, metadata: { addressVerified: true } })
    ).resolves.toEqual({ addresses: [], userIds: [] });
  });

  it('the control: the same address on a verified account receipt is refused', async () => {
    // Without it the cases above would pass on a check that refuses nothing.
    await eraseWaitlistEntry({ entryId: 'entry-1', actorUserId: null, reason: 'self_service' });
    const receipt = writtenReceipt();

    await expect(
      writersRefuse({
        ...receipt,
        subjectKind: 'account',
        subjectUserId: 'gone-user',
        metadata: { addressVerified: true },
      })
    ).resolves.toEqual({ addresses: [ADDRESS], userIds: [] });
  });
});
