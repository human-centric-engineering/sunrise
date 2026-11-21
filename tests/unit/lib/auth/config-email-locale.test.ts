/**
 * The auth emails go out in the user's language (§138 t-1075).
 *
 * Each hook works out its recipient's language from the user it is sending
 * to (`emailLocaleForUser`, tested on its own in
 * `tests/unit/lib/email/locale.test.ts`) and writes both the body and the
 * subject in it. Here that answer is the pseudo-locale, so a subject or body
 * still in English is one the hook did not translate.
 *
 * @see lib/auth/config.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@react-email/render';
import type { ReactElement } from 'react';

const mockEnv = vi.hoisted(() => ({
  REQUIRE_EMAIL_VERIFICATION: true,
  BETTER_AUTH_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  RESEND_API_KEY: 'test-resend-key',
  EMAIL_FROM: 'test@example.com',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
}));

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

const where = vi.hoisted(() => ({ locale: 'en-XA', timeZone: 'Asia/Tokyo' }));
vi.mock('@/lib/email/locale', () => ({ emailLocaleForUser: vi.fn(async () => where) }));

import { sendEmail } from '@/lib/email/send';
import { emailLocaleForUser } from '@/lib/email/locale';
import {
  afterEmailVerificationHook,
  sendChangeEmailConfirmationHook,
  sendResetPasswordHook,
  sendVerificationEmailHook,
} from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

const user = { id: 'u-1', email: 'ada@example.com', name: null };

type Sent = { to: string; subject: string; react: ReactElement };
function sent(): Sent {
  const [args] = vi.mocked(sendEmail).mock.calls[0] as unknown as [Sent];
  return args;
}

/** Bracketed and accented: the whole subject came from the catalogue. */
const PSEUDO_SUBJECT = /^\[[^\]]*[åéîöûšţ][^\]]*\]$/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ success: true, status: 'sent', id: 'e-1' });
  vi.mocked(prisma.account.findFirst).mockResolvedValue({ id: 'acc-1' } as never);
});

async function expectWrittenInUsersLanguage(): Promise<string> {
  expect(emailLocaleForUser).toHaveBeenCalledWith('u-1');
  expect(sent().subject).toMatch(PSEUDO_SUBJECT);
  const html = await render(sent().react);
  expect(html).toContain('lang="en-XA"');
  // The name-less greeting uses the catalogue's fallback name, in the same language.
  expect(html).toContain('[Ĥî [Ûšéŕ],]');
  return html;
}

describe('auth emails in the recipient’s language', () => {
  it('writes the password reset in it', async () => {
    await sendResetPasswordHook({ user, url: 'https://example.test/reset', token: 't' });
    await expectWrittenInUsersLanguage();
  });

  it('writes the verification email in it, and dates the link in their zone', async () => {
    await sendVerificationEmailHook({
      user,
      url: 'https://example.test/verify?callbackURL=%2F',
      token: 't',
    });
    const html = await expectWrittenInUsersLanguage();
    expect(html).toMatch(/GMT\+9/);
  });

  it('writes the email-change approval in it', async () => {
    await sendChangeEmailConfirmationHook({
      user,
      newEmail: 'new@example.com',
      url: 'https://example.test/approve',
      token: 't',
    });
    await expectWrittenInUsersLanguage();
  });

  it('writes the welcome sent after verification in it', async () => {
    await afterEmailVerificationHook(user);
    await expectWrittenInUsersLanguage();
  });
});
