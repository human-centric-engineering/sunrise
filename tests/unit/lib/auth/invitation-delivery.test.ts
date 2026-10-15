/**
 * Unit Tests: lib/auth/invitation-delivery.ts (§111 t-813)
 *
 * Token store and mailer are mocked at the module; the link, the resend
 * branch, the message wording and the failure log are the unit's own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' } }));
vi.mock('@/lib/utils/invitation-token', () => ({
  generateInvitationToken: vi.fn(),
  updateInvitationToken: vi.fn(),
}));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/registry', () => ({ resolveEmailTemplate: vi.fn(() => null) }));

import { deliverInvitation } from '@/lib/auth/invitation-delivery';
import { generateInvitationToken, updateInvitationToken } from '@/lib/utils/invitation-token';
import { sendEmail } from '@/lib/email/send';
import { resolveEmailTemplate } from '@/lib/email/registry';
import type { Logger } from '@/lib/logging';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const metadata = {
  name: 'Jane',
  role: 'USER',
  invitedBy: 'u1',
  invitedAt: '2026-10-15T00:00:00.000Z',
} as const;

function run(isResend: boolean, email = 'jane+x@example.com') {
  return deliverInvitation({
    email,
    name: 'Jane',
    metadata,
    isResend,
    inviterName: 'Admin',
    log: log as unknown as Logger,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateInvitationToken).mockResolvedValue('new-token');
  vi.mocked(updateInvitationToken).mockResolvedValue('re-token');
  vi.mocked(sendEmail).mockResolvedValue({ success: true, status: 'sent', id: 'm1' });
});

describe('deliverInvitation', () => {
  it('generates a token when not resending, and links with the token and encoded email', async () => {
    const res = await run(false);

    expect(generateInvitationToken).toHaveBeenCalledWith('jane+x@example.com', metadata);
    expect(updateInvitationToken).not.toHaveBeenCalled();
    expect(res.link).toBe(
      'https://app.example.com/accept-invite?token=new-token&email=jane%2Bx%40example.com'
    );
  });

  it('replaces the token when resending', async () => {
    const res = await run(true);

    expect(updateInvitationToken).toHaveBeenCalledWith('jane+x@example.com', metadata);
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(res.link).toContain('token=re-token');
  });

  it('mails the invitee the same link it returns, and expires it in about 7 days', async () => {
    const res = await run(false);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane+x@example.com',
        subject: expect.stringMatching(/invited/),
      })
    );
    expect(resolveEmailTemplate).toHaveBeenCalledWith(
      'invitation',
      expect.objectContaining({
        invitationUrl: res.link,
        inviterName: 'Admin',
        inviteeName: 'Jane',
      })
    );
    const days = (res.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it.each([
    [false, 'sent', 'Invitation sent successfully'],
    [true, 'sent', 'Invitation resent successfully'],
    [false, 'failed', 'Invitation created but email failed to send'],
    [true, 'failed', 'Invitation regenerated but email failed to send'],
    [false, 'disabled', 'Invitation created (email service not configured)'],
    [true, 'disabled', 'Invitation regenerated (email service not configured)'],
  ] as const)('resend=%s status=%s says "%s"', async (isResend, status, message) => {
    vi.mocked(sendEmail).mockResolvedValue({
      success: status === 'sent',
      status,
      ...(status === 'failed' ? { error: 'boom' } : {}),
    });

    const res = await run(isResend);

    expect(res.message).toBe(message);
    expect(res.emailStatus).toBe(status);
  });

  it('logs a warning, still returns the link, when the send fails', async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      success: false,
      status: 'failed',
      error: 'smtp down',
    });

    const res = await run(false);

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to send invitation email',
      expect.objectContaining({ email: 'jane+x@example.com', error: 'smtp down' })
    );
    expect(res.link).toContain('token=new-token');
  });

  it('does not warn when the send succeeds', async () => {
    await run(false);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });
});
