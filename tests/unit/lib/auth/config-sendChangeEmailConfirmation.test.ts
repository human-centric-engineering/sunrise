/**
 * Auth Config sendChangeEmailConfirmation Callback Tests
 *
 * This hook is the control that makes a stolen session insufficient for account
 * takeover (#489): better-auth writes nothing when `/change-email` is called, so
 * whoever holds the session can only *request* the move — completing it needs
 * the approval link that goes to the address already on the account.
 *
 * The single most important assertion in this file is therefore the recipient.
 * Sending to `newEmail` would hand the attacker the approval they need and
 * silently reinstate the whole vulnerability while still looking implemented.
 *
 * @see lib/auth/config.ts (sendChangeEmailConfirmationHook)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createMockUser } from '@/tests/types/mocks';

const mockEnv = {
  REQUIRE_EMAIL_VERIFICATION: undefined as boolean | undefined,
  BETTER_AUTH_URL: 'http://localhost:3000',
  NODE_ENV: 'test' as 'test' | 'development' | 'production',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  RESEND_API_KEY: 'test-resend-key',
  EMAIL_FROM: 'test@example.com',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
};

vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('better-auth', () => ({
  betterAuth: vi.fn(() => ({ api: { getSession: vi.fn() }, handler: vi.fn() })),
}));

vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: vi.fn(() => ({})) }));

vi.mock('better-auth/api', () => ({
  getOAuthState: vi.fn(),
  // Identity passthrough — lib/auth/config.ts wraps its `hooks.before` body in
  // this at module load, so an unmocked export throws on import (#463).
  createAuthMiddleware: vi.fn((fn: unknown) => fn),
  APIError: class APIError extends Error {},
}));

vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ validateEmailConfig: vi.fn() }));
vi.mock('@/lib/brand', () => ({ BRAND: { name: 'Aurora Labs' } }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { user: { update: vi.fn() }, account: { findFirst: vi.fn() } },
}));

vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
}));

vi.mock('@/lib/validations/user', () => ({
  DEFAULT_USER_PREFERENCES: {
    email: { marketing: false, productUpdates: true, securityAlerts: true },
  },
}));

vi.mock('@/lib/auth/change-email', () => ({
  parseEmailChangeToken: vi.fn().mockResolvedValue(null),
  getVerificationTokenFromRequest: vi.fn(() => undefined),
}));

vi.mock('@/lib/auth/sessions', () => ({
  revokeUserSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/emails/welcome', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Welcome Email')),
}));
vi.mock('@/emails/verify-email', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Verify Email')),
}));
vi.mock('@/emails/reset-password', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Reset Password Email')),
}));
vi.mock('@/emails/change-email-approval', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Change Email Approval')),
}));

describe('lib/auth/config - sendChangeEmailConfirmation callback', () => {
  let sendEmail: ReturnType<typeof vi.fn>;
  let ChangeEmailApproval: ReturnType<typeof vi.fn>;
  let sendChangeEmailConfirmationHook: (params: {
    user: { id: string; email: string; name: string | null };
    newEmail: string;
    url: string;
    token: string;
  }) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const emailSend = await import('@/lib/email/send');
    const template = await import('@/emails/change-email-approval');
    const authConfig = await import('@/lib/auth/config');

    sendEmail = vi.mocked(emailSend.sendEmail);
    ChangeEmailApproval = vi.mocked(template.default);
    sendChangeEmailConfirmationHook = authConfig.sendChangeEmailConfirmationHook;

    sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the approval to the CURRENT address, never the new one', async () => {
    // The assertion the whole feature rests on. Mailing `newEmail` would give an
    // attacker holding a stolen session the approval link they need.
    const user = createMockUser({ id: 'u-1', email: 'old@example.com', name: 'Owner' });

    await sendChangeEmailConfirmationHook({
      user,
      newEmail: 'attacker@evil.com',
      url: 'https://app.example.com/api/auth/verify-email?token=abc',
      token: 'abc',
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'old@example.com' }));
    const recipient = (sendEmail.mock.calls[0]?.[0] as { to: string }).to;
    expect(recipient).not.toBe('attacker@evil.com');
  });

  it('tells the recipient which address the account would move to', async () => {
    // Without the destination in the copy the owner cannot tell a change they
    // made from one an attacker made.
    const user = createMockUser({ id: 'u-2', email: 'old@example.com', name: 'Owner' });

    await sendChangeEmailConfirmationHook({
      user,
      newEmail: 'new@example.com',
      url: 'https://app.example.com/api/auth/verify-email?token=abc',
      token: 'abc',
    });

    expect(ChangeEmailApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        approvalUrl: 'https://app.example.com/api/auth/verify-email?token=abc',
      })
    );
  });

  it('falls back to "User" when the account has no name', async () => {
    const user = createMockUser({ id: 'u-3', email: 'old@example.com', name: null });

    await sendChangeEmailConfirmationHook({
      user,
      newEmail: 'new@example.com',
      url: 'https://app.example.com/verify',
      token: 'abc',
    });

    expect(ChangeEmailApproval).toHaveBeenCalledWith(expect.objectContaining({ userName: 'User' }));
  });
});
