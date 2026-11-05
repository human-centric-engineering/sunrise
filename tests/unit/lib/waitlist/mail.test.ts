/**
 * Unit tests: the email a waitlist join sends (§125 t-977).
 *
 * Runs the real registry, templates and token links against a mocked Prisma
 * and a mocked `sendEmail`, so what is asserted is the message that would
 * leave: which kind, to whom, with which links, and whether the hourly cap let
 * it go at all.
 *
 * @see lib/waitlist/mail.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@react-email/render';
import type { ReactElement } from 'react';

const { mockPrisma, mockSendEmail, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    waitlistEntry: { updateMany: vi.fn(), findUnique: vi.fn() },
    waitlistConfirmToken: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        waitlistConfirmToken: {
          deleteMany: vi.fn(),
          create: vi.fn().mockResolvedValue({ id: 'v-new' }),
        },
      })
    ),
  },
  mockSendEmail: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/email/send', () => ({ sendEmail: mockSendEmail }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

import {
  firstNameOf,
  mailForOutcome,
  sendWaitlistJoinMail,
  WAITLIST_CONFIRM_MAX_LINKS,
  WAITLIST_MAIL_INTERVAL_MS,
  WAITLIST_NOTE_INTERVAL_MS,
} from '@/lib/waitlist/mail';
import { verifyLeaveToken } from '@/lib/waitlist/tokens';

const NOW = new Date('2026-11-04T12:00:00Z');
const ADDRESS = 'ada@example.com';
/** When the entry's retention window started: its join, a day ago. */
const JOINED = new Date('2026-11-03T12:00:00Z');

type Sent = { to: string; subject: string; react: ReactElement };
function sent(): Sent {
  const [args] = mockSendEmail.mock.calls[0] as [Sent];
  return args;
}

/** The entry as both reads see it: the claim's and the send's. */
function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    email: ADDRESS,
    name: 'Ada Lovelace',
    lastEmailedAt: null,
    removedAt: null,
    flaggedReason: null,
    confirmWindowFrom: JOINED,
    confirmLinksSent: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.waitlistEntry.findUnique.mockResolvedValue(entryRow());
  mockPrisma.waitlistConfirmToken.deleteMany.mockResolvedValue({ count: 1 });
  mockSendEmail.mockResolvedValue({ success: true, status: 'sent' });
});

describe('firstNameOf', () => {
  it.each([
    ['Ada Lovelace', 'Ada'],
    ['  Zoë  ', 'Zoë'],
    ["O'Brien", "O'Brien"],
    ['Jean-Luc Picard', 'Jean-Luc'],
    ['李', '李'],
  ])('%j → %j', (name, expected) => {
    expect(firstNameOf(name)).toBe(expected);
  });

  it.each([
    'https://evil.example',
    'evil.example',
    'www.evil.example/login',
    '---',
    "''",
    '1337',
    'a'.repeat(41),
    '<b>Ada</b>',
    '',
    null,
    undefined,
  ])('refuses %j', (name) => {
    expect(firstNameOf(name)).toBeNull();
  });
});

describe('mailForOutcome', () => {
  it('sends the link before confirmation, the note after, and nothing to a removed entry', () => {
    expect(mailForOutcome('created')).toBe('waitlistConfirm');
    expect(mailForOutcome('replaced')).toBe('waitlistConfirm');
    expect(mailForOutcome('filled')).toBe('waitlistAlreadyOnList');
    expect(mailForOutcome('unchanged')).toBe('waitlistAlreadyOnList');
    expect(mailForOutcome('rejoin-counted')).toBeNull();
  });
});

describe('sendWaitlistJoinMail', () => {
  it('sends a new entry the confirmation, with a fresh confirm link and a signed leave link', async () => {
    // Act
    const result = await sendWaitlistJoinMail('entry-1', 'created', NOW);

    // Assert
    expect(result).toBe('sent');
    expect(sent().to).toBe(ADDRESS);
    expect(sent().subject).toMatch(/Confirm your place/);
    const html = await render(sent().react);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const confirm = links.map((l) => new URL(l)).find((u) => u.pathname === '/waitlist/confirm');
    const leave = links.map((l) => new URL(l)).find((u) => u.pathname === '/waitlist/leave');
    expect(confirm?.searchParams.get('entry')).toBe('entry-1');
    expect(confirm?.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLeaveToken(leave?.searchParams.get('token') ?? '')).toBe('entry-1');
    // The first name only, filtered
    expect(html).toContain('Hi Ada,');
    expect(html).not.toContain('Lovelace');
  });

  it('claims the hour, starts the retention window again and counts the link, conditional on the values it read', async () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * WAITLIST_MAIL_INTERVAL_MS);
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(
      entryRow({ lastEmailedAt: twoHoursAgo, confirmLinksSent: 1 })
    );

    await sendWaitlistJoinMail('entry-1', 'replaced', NOW);

    // Of two concurrent joins that read the same values, only one write matches
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'entry-1',
        removedAt: null,
        flaggedReason: null,
        lastEmailedAt: twoHoursAgo,
        confirmLinksSent: 1,
      },
      // The new link is good for a week, so the entry must outlive it
      data: { lastEmailedAt: NOW, confirmWindowFrom: NOW, confirmLinksSent: { increment: 1 } },
    });
  });

  it('claims only the hour for the note: a confirmed entry has no window to move', async () => {
    await sendWaitlistJoinMail('entry-1', 'unchanged', NOW);

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-1', removedAt: null, flaggedReason: null, lastEmailedAt: null },
      data: { lastEmailedAt: NOW },
    });
  });

  it('sends no more links once the entry has had its last, so resubmitting cannot keep it', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(
      entryRow({ confirmLinksSent: WAITLIST_CONFIRM_MAX_LINKS })
    );

    expect(await sendWaitlistJoinMail('entry-1', 'replaced', NOW)).toBe('capped');
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('sends nothing to an entry screen() flagged', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(entryRow({ flaggedReason: 'flagged' }));

    expect(await sendWaitlistJoinMail('entry-1', 'created', NOW)).toBe('held');
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing and issues no token when an email went out in the last hour', async () => {
    // Arrange
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(
      entryRow({ lastEmailedAt: new Date(NOW.getTime() - WAITLIST_MAIL_INTERVAL_MS / 2) })
    );

    // Act
    const result = await sendWaitlistJoinMail('entry-1', 'replaced', NOW);

    // Assert
    expect(result).toBe('capped');
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('sends the note only once its longer wait has passed, so a confirmed owner is not mailed hourly', async () => {
    // Arrange — two hours since the last email: the hour has passed, the note's wait has not
    const twoHoursAgo = new Date(NOW.getTime() - 2 * WAITLIST_MAIL_INTERVAL_MS);
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(entryRow({ lastEmailedAt: twoHoursAgo }));

    // Act
    const result = await sendWaitlistJoinMail('entry-1', 'unchanged', NOW);

    // Assert
    expect(result).toBe('capped');
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends the note again once its wait has passed', async () => {
    const longAgo = new Date(NOW.getTime() - WAITLIST_NOTE_INTERVAL_MS - 1);
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(entryRow({ lastEmailedAt: longAgo }));

    expect(await sendWaitlistJoinMail('entry-1', 'filled', NOW)).toBe('sent');
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-1', removedAt: null, flaggedReason: null, lastEmailedAt: longAgo },
      data: { lastEmailedAt: NOW },
    });
  });

  it('counts a send with email not configured as not sent, so the link is not used up', async () => {
    // Arrange — sendEmail reports success with status disabled in development and test
    mockSendEmail.mockResolvedValue({ success: true, status: 'disabled', id: 'mock-1' });

    // Act
    const result = await sendWaitlistJoinMail('entry-1', 'created', NOW);

    // Assert — the claim is undone as for a failed send
    expect(result).toBe('not-sent');
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'entry-1', lastEmailedAt: NOW },
      data: { lastEmailedAt: null, confirmWindowFrom: JOINED, confirmLinksSent: { decrement: 1 } },
    });
    expect(mockPrisma.waitlistConfirmToken.deleteMany).toHaveBeenCalledWith({
      where: { id: 'v-new' },
    });
  });

  it('sends nothing when a concurrent join took the slot between the read and the write', async () => {
    // Arrange — the conditional claim matched no row
    mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 0 });

    // Act
    const result = await sendWaitlistJoinMail('entry-1', 'replaced', NOW);

    // Assert
    expect(result).toBe('capped');
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('sends nothing to a removed entry', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(entryRow({ removedAt: NOW }));

    expect(await sendWaitlistJoinMail('entry-1', 'replaced', NOW)).toBe('none');
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('on a failed send, gives the slot back and withdraws the link it never delivered', async () => {
    // Arrange — a link went out two hours ago; this one fails
    const twoHoursAgo = new Date(NOW.getTime() - 2 * WAITLIST_MAIL_INTERVAL_MS);
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(entryRow({ lastEmailedAt: twoHoursAgo }));
    mockSendEmail.mockResolvedValue({ success: false, status: 'failed', error: 'provider down' });

    // Act
    const result = await sendWaitlistJoinMail('entry-1', 'replaced', NOW);

    // Assert — the claim is undone only if nothing claimed since…
    expect(result).toBe('not-sent');
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'entry-1', lastEmailedAt: NOW },
      // The window and the link count as they were: no link reached anyone
      data: {
        lastEmailedAt: twoHoursAgo,
        confirmWindowFrom: JOINED,
        confirmLinksSent: { decrement: 1 },
      },
    });
    // …and only the new, undelivered token goes: the earlier link still works
    expect(mockPrisma.waitlistConfirmToken.deleteMany).toHaveBeenCalledWith({
      where: { id: 'v-new' },
    });
  });

  it('gives the slot back on a send that throws too', async () => {
    mockSendEmail.mockRejectedValue(new Error('network'));

    expect(await sendWaitlistJoinMail('entry-1', 'created', NOW)).toBe('not-sent');
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'entry-1', lastEmailedAt: NOW },
      data: { lastEmailedAt: null, confirmWindowFrom: JOINED, confirmLinksSent: { decrement: 1 } },
    });
    expect(mockPrisma.waitlistConfirmToken.deleteMany).toHaveBeenCalledWith({
      where: { id: 'v-new' },
    });
  });

  it('gives the slot back, with no token to withdraw, when the note fails', async () => {
    mockSendEmail.mockResolvedValue({ success: false, status: 'failed', error: 'bounced' });

    expect(await sendWaitlistJoinMail('entry-1', 'unchanged', NOW)).toBe('not-sent');
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'entry-1', lastEmailedAt: NOW },
      data: { lastEmailedAt: null },
    });
    expect(mockPrisma.waitlistConfirmToken.deleteMany).not.toHaveBeenCalled();
  });

  it('sends a confirmed repeat the note, with no confirm link', async () => {
    // Act
    const result = await sendWaitlistJoinMail('entry-1', 'unchanged', NOW);

    // Assert
    expect(result).toBe('sent');
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledOnce();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    const html = await render(sent().react);
    expect(html).toContain('already on the list');
    expect(html).not.toContain('/waitlist/confirm');
    expect(html).toContain('/waitlist/leave');
  });

  it('greets a name that is not a first name impersonally', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(entryRow({ name: 'evil.example/login' }));

    await sendWaitlistJoinMail('entry-1', 'created', NOW);

    const html = await render(sent().react);
    expect(html).toContain('Hello,');
    expect(html).not.toContain('evil.example');
  });

  it('sends nothing for a removed re-join, without touching the cap', async () => {
    const result = await sendWaitlistJoinMail('entry-1', 'rejoin-counted', NOW);

    expect(result).toBe('none');
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('reports a failed send and a throw without throwing, and never logs the address', async () => {
    mockSendEmail.mockResolvedValueOnce({ success: false, status: 'failed', error: 'bounced' });
    expect(await sendWaitlistJoinMail('entry-1', 'created', NOW)).toBe('not-sent');

    mockSendEmail.mockRejectedValueOnce(new Error('network'));
    expect(await sendWaitlistJoinMail('entry-1', 'created', NOW)).toBe('not-sent');

    const logged = JSON.stringify([
      mockLogger.info.mock.calls,
      mockLogger.warn.mock.calls,
      mockLogger.error.mock.calls,
    ]);
    expect(logged).toContain('entry-1');
    expect(logged).not.toContain(ADDRESS);
  });
});
