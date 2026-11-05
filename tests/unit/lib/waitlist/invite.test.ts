/**
 * Unit tests: inviting from the waitlist (§125 t-978)
 *
 * What reaches the database and `deliverInvitation()` for each invite: every
 * refusal, the stamp's conditional `where`, the metadata the invitation
 * carries, the restore when issuing fails, and how a wave chooses and reports
 * its rows. Postgres's re-evaluation of the stamp on the locked row is a
 * property of the database, not asserted here.
 *
 * @see lib/waitlist/invite.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_WAITLIST_JOIN_PATH,
  DEFAULT_WAITLIST_RETENTION,
  type ResolvedWaitlistConfig,
} from '@/lib/waitlist/config';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const { mockPrisma, mockDeliver, mockRequireOrgId, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    waitlistEntry: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    verification: { findMany: vi.fn(), deleteMany: vi.fn() },
  },
  mockDeliver: vi.fn(),
  mockRequireOrgId: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));
vi.mock('@/lib/auth/invitation-delivery', () => ({ deliverInvitation: mockDeliver }));
vi.mock('@/lib/tenancy/context', () => ({ requireOrgId: mockRequireOrgId }));

import { inviteWaitlistEntry, inviteWaitlistWave, selectWaveEntries } from '@/lib/waitlist/invite';

const NOW = new Date('2026-11-05T10:00:00Z');
const EXPIRES = new Date('2026-11-12T10:00:00Z');
const INVITER = { id: 'admin-1', name: 'Grace Admin' };
const log = mockLogger as unknown as Parameters<typeof inviteWaitlistEntry>[0]['log'];

/** A confirmed, live entry that may be invited. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    list: 'default',
    details: null,
    confirmedAt: new Date('2026-11-01T00:00:00Z'),
    removedAt: null,
    joinedAt: null,
    userId: null,
    flaggedReason: null,
    invitedAt: null,
    ...over,
  };
}

/** A stored invitation row, as `prisma.verification` holds it. */
function invitationRow(id: string, waitlistEntryId?: string) {
  return {
    id,
    metadata: {
      name: 'Ada',
      role: 'USER',
      invitedBy: 'someone',
      invitedAt: '2026-11-02T00:00:00.000Z',
      ...(waitlistEntryId ? { waitlistEntryId } : {}),
    },
  };
}

function invite(entryId = 'entry-1') {
  return inviteWaitlistEntry({ entryId, inviter: INVITER, log, now: NOW });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOrgId.mockReturnValue(INSTALL_ORG_ID);
  mockPrisma.waitlistEntry.findUnique.mockResolvedValue(row());
  mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.verification.findMany.mockResolvedValue([]);
  mockPrisma.verification.deleteMany.mockResolvedValue({ count: 0 });
  mockDeliver.mockResolvedValue({
    link: 'http://localhost/accept-invite?token=t',
    expiresAt: EXPIRES,
    emailStatus: 'sent',
    message: 'ok',
  });
});

describe('inviteWaitlistEntry — refusals', () => {
  it.each([
    ['removed', { removedAt: new Date() }],
    ['joined', { joinedAt: new Date() }],
    ['joined', { userId: 'user-9' }],
    ['unconfirmed', { confirmedAt: null }],
    ['flagged', { flaggedReason: 'disposable-domain' }],
  ])('refuses %s (%j) without stamping or sending', async (reason, over) => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(row(over));

    const result = await invite();

    expect(result).toEqual({ outcome: 'refused', reason });
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('refuses removed ahead of unconfirmed when an entry is both', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(
      row({ removedAt: new Date(), confirmedAt: null })
    );

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'removed' });
  });

  it('refuses not_found when the entry is not in this org', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(null);

    expect(await invite('missing')).toEqual({ outcome: 'refused', reason: 'not_found' });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('refuses account_exists when the address already has an account, looked up by that address', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'account_exists' });
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'ada@example.com' } })
    );
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('looks up the unexpired invitations for the address', async () => {
    await invite();

    expect(mockPrisma.verification.findMany).toHaveBeenCalledWith({
      where: { identifier: 'invitation:ada@example.com', expiresAt: { gt: NOW } },
      select: { id: true, metadata: true },
    });
  });

  it('refuses invitation_pending when the pending invitation names another entry', async () => {
    mockPrisma.verification.findMany.mockResolvedValue([invitationRow('inv-x', 'other-entry')]);

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'invitation_pending' });
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('refuses invitation_pending when the pending invitation names no entry (Admin → Users)', async () => {
    mockPrisma.verification.findMany.mockResolvedValue([invitationRow('inv-x')]);

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'invitation_pending' });
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('refuses invitation_pending when a pending invitation cannot be read, rather than issuing beside it', async () => {
    mockPrisma.verification.findMany.mockResolvedValue([{ id: 'inv-x', metadata: { junk: 1 } }]);

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'invitation_pending' });
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("refuses invitation_pending when someone else's invitation sits beside this entry's own", async () => {
    mockPrisma.verification.findMany.mockResolvedValue([
      invitationRow('inv-own', 'entry-1'),
      invitationRow('inv-x'),
    ]);

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'invitation_pending' });
    expect(mockPrisma.verification.deleteMany).not.toHaveBeenCalled();
  });

  it('fails, without stamping or sending, when the invitation lookup fails', async () => {
    const failure = new Error('db down');
    mockPrisma.verification.findMany.mockRejectedValue(failure);

    await expect(invite()).rejects.toBe(failure);
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('refuses changed, and sends nothing, when the stamp matches no row', async () => {
    mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 0 });

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'changed' });
    expect(mockDeliver).not.toHaveBeenCalled();
  });
});

describe('inviteWaitlistEntry — the stamp', () => {
  it('re-checks every refusal and the invitedAt it read, then sets invitedAt to now', async () => {
    const readAt = new Date('2026-10-30T00:00:00Z');
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(row({ invitedAt: readAt }));

    await invite();

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'entry-1',
        invitedAt: readAt,
        removedAt: null,
        joinedAt: null,
        userId: null,
        confirmedAt: { not: null },
        flaggedReason: null,
      },
      data: { invitedAt: NOW },
    });
  });

  it('stamps before the invitation is issued', async () => {
    const order: string[] = [];
    mockPrisma.waitlistEntry.updateMany.mockImplementation(async () => {
      order.push('stamp');
      return { count: 1 };
    });
    mockDeliver.mockImplementation(async () => {
      order.push('deliver');
      return { link: 'l', expiresAt: EXPIRES, emailStatus: 'sent', message: 'ok' };
    });

    await invite();

    expect(order).toEqual(['stamp', 'deliver']);
  });
});

describe('inviteWaitlistEntry — the invitation', () => {
  it('invites as USER with the entry id, and no orgId for the install org', async () => {
    const result = await invite();

    expect(mockDeliver).toHaveBeenCalledTimes(1);
    const arg = mockDeliver.mock.calls[0][0] as {
      email: string;
      isResend: boolean;
      inviterName: string;
      metadata: Record<string, unknown>;
    };
    expect(arg.email).toBe('ada@example.com');
    expect(arg.isResend).toBe(false);
    expect(arg.inviterName).toBe('Grace Admin');
    expect(arg.metadata).toEqual({
      name: 'Ada Lovelace',
      role: 'USER',
      invitedBy: 'admin-1',
      invitedAt: NOW.toISOString(),
      waitlistEntryId: 'entry-1',
    });
    expect(arg.metadata).not.toHaveProperty('orgId');
    expect(result).toMatchObject({ outcome: 'invited', emailStatus: 'sent', expiresAt: EXPIRES });
  });

  it('names the org for an org other than the install org', async () => {
    mockRequireOrgId.mockReturnValue('org-acme');

    await invite();

    const arg = mockDeliver.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(arg.metadata).toMatchObject({ orgId: 'org-acme', role: 'USER' });
  });

  it('falls back to the address local part for the account name when the entry has none', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(row({ name: null }));

    await invite();

    const arg = mockDeliver.mock.calls[0][0] as {
      name: string;
      metadata: { name: string };
    };
    expect(arg.metadata.name).toBe('ada');
    expect(arg.name).toBe('there');
  });

  it('greets by first name only, and an impersonal "there" for a URL-like name', async () => {
    await invite();
    expect((mockDeliver.mock.calls[0][0] as { name: string }).name).toBe('Ada');

    mockDeliver.mockClear();
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(row({ name: 'https://evil.example' }));
    await invite();
    const arg = mockDeliver.mock.calls[0][0] as { name: string; metadata: { name: string } };
    expect(arg.name).toBe('there');
    // The account name is not the greeting: it is the name they gave.
    expect(arg.metadata.name).toBe('https://evil.example');
  });

  it('uses "The team" when the inviter has no name', async () => {
    await inviteWaitlistEntry({
      entryId: 'entry-1',
      inviter: { id: 'admin-1', name: null },
      log,
      now: NOW,
    });

    expect((mockDeliver.mock.calls[0][0] as { inviterName: string }).inviterName).toBe('The team');
  });

  it('re-sends, with a fresh invitedAt, when the pending invitation carries this entry', async () => {
    mockPrisma.verification.findMany.mockResolvedValue([invitationRow('inv-own', 'entry-1')]);

    const result = await invite();

    expect(result).toMatchObject({ outcome: 'resent' });
    if (result.outcome === 'resent') expect(result.entry.invitedAt).toEqual(NOW);
  });

  it('re-sends by deleting only its own invitations by id, never every one for the address', async () => {
    mockPrisma.verification.findMany.mockResolvedValue([
      invitationRow('inv-own-1', 'entry-1'),
      invitationRow('inv-own-2', 'entry-1'),
    ]);

    await invite();

    expect(mockPrisma.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['inv-own-1', 'inv-own-2'] } },
    });
    // Not deliverInvitation's re-send, which deletes every invitation for the address.
    expect((mockDeliver.mock.calls[0][0] as { isResend: boolean }).isResend).toBe(false);
    expect(mockPrisma.verification.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeliver.mock.invocationCallOrder[0]
    );
  });

  it('deletes nothing on a first invite', async () => {
    await invite();

    expect(mockPrisma.verification.deleteMany).not.toHaveBeenCalled();
  });

  it('returns the admin view of the entry with invitedAt now, and without userId', async () => {
    const result = await invite();

    expect(result.outcome).toBe('invited');
    if (result.outcome === 'refused') return;
    expect(result.entry).toMatchObject({ id: 'entry-1', list: 'default', invitedAt: NOW });
    expect(result.entry).not.toHaveProperty('userId');
  });

  it('is still "invited" when the email did not go, and says so', async () => {
    mockDeliver.mockResolvedValue({
      link: 'l',
      expiresAt: EXPIRES,
      emailStatus: 'failed',
      message: 'email failed',
    });

    const result = await invite();

    expect(result).toMatchObject({ outcome: 'invited', emailStatus: 'failed' });
    // The invitation exists, so the stamp is kept.
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('inviteWaitlistEntry — removed while inviting', () => {
  it('revokes the new invitation and refuses changed when the entry was removed after the stamp', async () => {
    mockPrisma.waitlistEntry.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce({ removedAt: NOW });
    mockPrisma.verification.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([invitationRow('inv-new', 'entry-1'), invitationRow('inv-x')]);
    mockPrisma.verification.deleteMany.mockResolvedValue({ count: 1 });

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'changed' });
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    // Read again only after the invitation exists.
    expect(mockPrisma.waitlistEntry.findUnique.mock.invocationCallOrder[1]).toBeGreaterThan(
      mockDeliver.mock.invocationCallOrder[0]
    );
    expect(mockPrisma.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['inv-new'] } },
    });
  });

  it('revokes and refuses changed when the entry was erased after the stamp', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockPrisma.verification.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([invitationRow('inv-new', 'entry-1')]);

    expect(await invite()).toEqual({ outcome: 'refused', reason: 'changed' });
    expect(mockPrisma.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['inv-new'] } },
    });
  });

  it('reports the invite, and logs, when the re-read fails', async () => {
    const failure = new Error('db blip');
    mockPrisma.waitlistEntry.findUnique.mockResolvedValueOnce(row()).mockRejectedValueOnce(failure);

    expect(await invite()).toMatchObject({ outcome: 'invited' });
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Waitlist invite: could not re-check the entry after inviting',
      failure,
      { entryId: 'entry-1' }
    );
    expect(mockPrisma.verification.deleteMany).not.toHaveBeenCalled();
  });
});

describe('inviteWaitlistEntry — issuing fails', () => {
  it('puts invitedAt back, conditioned on the stamp it wrote, and rethrows', async () => {
    const readAt = new Date('2026-10-30T00:00:00Z');
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(row({ invitedAt: readAt }));
    const failure = new Error('db down');
    mockDeliver.mockRejectedValue(failure);

    await expect(invite()).rejects.toBe(failure);

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'entry-1', invitedAt: NOW },
      data: { invitedAt: readAt },
    });
  });

  it('restores to null when the entry had never been invited', async () => {
    mockDeliver.mockRejectedValue(new Error('db down'));

    await expect(invite()).rejects.toThrow('db down');

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'entry-1', invitedAt: NOW },
      data: { invitedAt: null },
    });
  });

  it('rethrows the original error, and logs the restore failure, when the restore also fails', async () => {
    const failure = new Error('issue failed');
    mockDeliver.mockRejectedValue(failure);
    mockPrisma.waitlistEntry.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('restore failed'));

    await expect(invite()).rejects.toBe(failure);

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Waitlist invite: could not put invitedAt back',
      expect.objectContaining({ message: 'restore failed' }),
      { entryId: 'entry-1' }
    );
  });
});

// ── selectWaveEntries ───────────────────────────────────────────────────────

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [{ key: 'role', label: 'Role', kind: 'text' }],
  lists: [{ key: 'default' }, { key: 'beta' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
  joinPath: DEFAULT_WAITLIST_JOIN_PATH,
};

const INVITABLE_WHERE = {
  removedAt: null,
  joinedAt: null,
  userId: null,
  confirmedAt: { not: null },
  flaggedReason: null,
};

type FindManyArgs = {
  where: { AND: unknown[] };
  select: unknown;
  orderBy?: unknown;
  take?: number;
};
const findManyArgs = (): FindManyArgs => mockPrisma.waitlistEntry.findMany.mock.calls[0][0];

describe('selectWaveEntries', () => {
  it('ids mode returns the ticked ids without duplicates and reads nothing', async () => {
    const ids = await selectWaveEntries(CONFIG, { mode: 'ids', ids: ['a', 'b', 'a', 'c', 'b'] });

    expect(ids).toEqual(['a', 'b', 'c']);
    expect(mockPrisma.waitlistEntry.findMany).not.toHaveBeenCalled();
  });

  it('next mode takes the oldest not-yet-invited invitable entries on declared lists', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);

    const ids = await selectWaveEntries(CONFIG, { mode: 'next', count: 2 });

    expect(ids).toEqual(['e1', 'e2']);
    expect(findManyArgs()).toEqual({
      where: {
        AND: [INVITABLE_WHERE, { invitedAt: null, list: { in: ['default', 'beta'] } }],
      },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 2,
    });
  });

  it('narrows to one declared list when asked', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([]);

    await selectWaveEntries(CONFIG, { mode: 'next', count: 5, list: 'beta' });

    expect(findManyArgs().where.AND[1]).toEqual({ invitedAt: null, list: { in: ['beta'] } });
  });

  it('a list the config does not declare selects from no list', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([]);

    await selectWaveEntries(CONFIG, { mode: 'next', count: 5, list: 'ghost' });

    expect(findManyArgs().where.AND[1]).toEqual({ invitedAt: null, list: { in: [] } });
  });

  it('adds a details path match for an answer on a declared field', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([]);

    await selectWaveEntries(CONFIG, {
      mode: 'next',
      count: 5,
      answer: { field: 'role', value: 'dj' },
    });

    expect(findManyArgs().where.AND).toContainEqual({
      details: { path: ['role'], equals: 'dj' },
    });
  });

  it.each(['next', 'sample'] as const)(
    '%s mode with an answer on an undeclared field selects nobody and reads nothing',
    async (mode) => {
      const ids = await selectWaveEntries(CONFIG, {
        mode,
        count: 5,
        answer: { field: 'removedField', value: 'x' },
      });

      expect(ids).toEqual([]);
      expect(mockPrisma.waitlistEntry.findMany).not.toHaveBeenCalled();
    }
  );

  it('sample mode returns count distinct ids drawn from the candidates', async () => {
    const pool = Array.from({ length: 20 }, (_, i) => `e${i}`);
    mockPrisma.waitlistEntry.findMany.mockResolvedValue(pool.map((id) => ({ id })));

    const ids = await selectWaveEntries(CONFIG, { mode: 'sample', count: 7 });

    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(ids.every((id) => pool.includes(id))).toBe(true);
    // Same candidate set as `next`, but no ordering and no take: the draw is here.
    expect(findManyArgs()).toEqual({
      where: {
        AND: [INVITABLE_WHERE, { invitedAt: null, list: { in: ['default', 'beta'] } }],
      },
      select: { id: true },
    });
  });

  it('sample mode returns every candidate when fewer than count are available', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    const ids = await selectWaveEntries(CONFIG, { mode: 'sample', count: 50 });

    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });

  it('sample mode over nobody returns nobody', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([]);

    expect(await selectWaveEntries(CONFIG, { mode: 'sample', count: 5 })).toEqual([]);
  });
});

// ── inviteWaitlistWave ──────────────────────────────────────────────────────

describe('inviteWaitlistWave', () => {
  it('reports each row and counts them, resent as invited and non-sent mail as emailNotSent', async () => {
    // Per entry id: ok, resend, refused (removed), email failed, email skipped.
    const rows: Record<string, ReturnType<typeof row> | null> = {
      ok: row({ id: 'ok', email: 'ok@example.com' }),
      resend: row({ id: 'resend', email: 'resend@example.com' }),
      gone: row({ id: 'gone', email: 'gone@example.com', removedAt: new Date() }),
      mailfail: row({ id: 'mailfail', email: 'mailfail@example.com' }),
      skipped: row({ id: 'skipped', email: 'skipped@example.com' }),
    };
    mockPrisma.waitlistEntry.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => rows[where.id]
    );
    mockPrisma.verification.findMany.mockImplementation(
      async ({ where }: { where: { identifier: string } }) =>
        where.identifier === 'invitation:resend@example.com'
          ? [invitationRow('inv-r', 'resend')]
          : []
    );
    mockDeliver.mockImplementation(async ({ email }: { email: string }) => ({
      link: 'l',
      expiresAt: EXPIRES,
      emailStatus:
        email === 'mailfail@example.com'
          ? 'failed'
          : email === 'skipped@example.com'
            ? 'skipped'
            : 'sent',
      message: 'm',
    }));

    const result = await inviteWaitlistWave({
      ids: ['ok', 'resend', 'gone', 'mailfail', 'skipped'],
      inviter: INVITER,
      log,
    });

    expect(result.rows).toEqual([
      { id: 'ok', outcome: 'invited', emailStatus: 'sent' },
      { id: 'resend', outcome: 'resent', emailStatus: 'sent' },
      { id: 'gone', outcome: 'refused', reason: 'removed' },
      { id: 'mailfail', outcome: 'invited', emailStatus: 'failed' },
      { id: 'skipped', outcome: 'invited', emailStatus: 'skipped' },
    ]);
    expect(result).toMatchObject({
      selected: 5,
      invited: 4,
      refused: 1,
      failed: 0,
      emailNotSent: 2,
    });
  });

  it('marks a row whose invitation could not be issued as failed, logs it, and carries on', async () => {
    mockPrisma.waitlistEntry.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        row({ id: where.id, email: `${where.id}@example.com` })
    );
    const failure = new Error('db down');
    mockDeliver
      .mockResolvedValueOnce({ link: 'l', expiresAt: EXPIRES, emailStatus: 'sent', message: 'm' })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ link: 'l', expiresAt: EXPIRES, emailStatus: 'sent', message: 'm' });

    const result = await inviteWaitlistWave({ ids: ['a', 'b', 'c'], inviter: INVITER, log });

    expect(result.rows).toEqual([
      { id: 'a', outcome: 'invited', emailStatus: 'sent' },
      { id: 'b', outcome: 'failed' },
      { id: 'c', outcome: 'invited', emailStatus: 'sent' },
    ]);
    expect(result).toMatchObject({ selected: 3, invited: 2, refused: 0, failed: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Waitlist wave: an invitation could not be issued',
      failure,
      { entryId: 'b' }
    );
  });

  it('answers selected: 0 with no rows for an empty wave', async () => {
    const result = await inviteWaitlistWave({ ids: [], inviter: INVITER, log });

    expect(result).toEqual({
      selected: 0,
      invited: 0,
      refused: 0,
      failed: 0,
      emailNotSent: 0,
      rows: [],
    });
    expect(mockPrisma.waitlistEntry.findUnique).not.toHaveBeenCalled();
  });
});
