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
    verification: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ verification: { deleteMany: vi.fn(), create: vi.fn() } })
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
  WAITLIST_MAIL_INTERVAL_MS,
} from '@/lib/waitlist/mail';
import { verifyLeaveToken } from '@/lib/waitlist/tokens';

const NOW = new Date('2026-11-04T12:00:00Z');
const ADDRESS = 'ada@example.com';

type Sent = { to: string; subject: string; react: ReactElement };
function sent(): Sent {
  const [args] = mockSendEmail.mock.calls[0] as [Sent];
  return args;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.waitlistEntry.findUnique.mockResolvedValue({ email: ADDRESS, name: 'Ada Lovelace' });
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

  it('claims the hour with a write conditional on the last email being an hour old', async () => {
    await sendWaitlistJoinMail('entry-1', 'replaced', NOW);

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'entry-1',
        removedAt: null,
        OR: [
          { lastEmailedAt: null },
          { lastEmailedAt: { lte: new Date(NOW.getTime() - WAITLIST_MAIL_INTERVAL_MS) } },
        ],
      },
      data: { lastEmailedAt: NOW },
    });
  });

  it('sends nothing and issues no token when an email went out in the last hour', async () => {
    // Arrange — the conditional claim matched no row
    mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 0 });

    // Act
    const result = await sendWaitlistJoinMail('entry-1', 'replaced', NOW);

    // Assert
    expect(result).toBe('capped');
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('sends a confirmed repeat the note, under the same cap, with no confirm link', async () => {
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
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue({
      email: ADDRESS,
      name: 'evil.example/login',
    });

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
