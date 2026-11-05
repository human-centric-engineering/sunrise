/**
 * What better-auth itself does on the new-address click of an email change.
 *
 * Everything else that tests this flow mocks the library, which is how 1.7.16
 * changed both behaviours below with every test still green. These drive the
 * real `/verify-email` handler, so a later bump that changes either one fails
 * here. `afterEmailVerificationHook` depends on both:
 *
 * - no session is minted for a click with no cookie, so it spares nothing. If a
 *   bump mints one again, revoking everything would delete the session that
 *   response hands back.
 * - the callback fires only for an account that was already verified, which is
 *   the known limitation in `.context/auth/security.md`.
 *
 * @see lib/auth/config.ts · .context/auth/security.md
 */

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { signJWT } from 'better-auth/crypto';
import { describe, it, expect, vi } from 'vitest';

const SECRET = 'email-change-contract-test-secret-0123456789';
const BASE_URL = 'http://localhost:3000';

async function clickNewAddressLink({
  emailVerified,
  callbackURL,
}: {
  emailVerified: boolean;
  callbackURL?: string;
}) {
  const now = new Date();
  const db: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: 'user-1',
        name: 'Mover',
        email: 'old@example.com',
        emailVerified,
        createdAt: now,
        updatedAt: now,
      },
    ],
    session: [
      {
        id: 'session-1',
        token: 'existing-session',
        userId: 'user-1',
        expiresAt: new Date(now.getTime() + 3_600_000),
        createdAt: now,
        updatedAt: now,
      },
    ],
    account: [],
    verification: [],
  };
  const afterEmailVerification = vi.fn().mockResolvedValue(undefined);
  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: SECRET,
    database: memoryAdapter(db),
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    user: { changeEmail: { enabled: true } },
    emailVerification: {
      sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
      afterEmailVerification,
    },
  });
  const token = await signJWT(
    {
      email: 'old@example.com',
      updateTo: 'new@example.com',
      requestType: 'change-email-verification',
      userId: 'user-1',
    },
    SECRET,
    3600
  );

  const response = await auth.handler(
    new Request(
      `${BASE_URL}/api/auth/verify-email?token=${token}` +
        (callbackURL ? `&callbackURL=${encodeURIComponent(callbackURL)}` : '')
    )
  );

  return { response, db, afterEmailVerification };
}

describe('better-auth on a cookie-less new-address click', () => {
  it('moves the address and fires the callback, minting no session', async () => {
    const { response, db, afterEmailVerification } = await clickNewAddressLink({
      emailVerified: true,
    });

    expect(response.status).toBe(200);
    expect(db.user[0]?.email).toBe('new@example.com');
    expect(afterEmailVerification).toHaveBeenCalledTimes(1);
    expect(db.session.map((s) => s.token)).toEqual(['existing-session']);
    expect(response.headers.get('set-cookie') ?? '').not.toContain('session_token');
  });

  it('redirects to a callback path that carries a query string', async () => {
    // sendVerificationEmailHook marks a change with `?emailChanged=1`; the origin
    // check must keep accepting that, or the callback page never sees it.
    const { response } = await clickNewAddressLink({
      emailVerified: true,
      callbackURL: '/verify-email/callback?emailChanged=1',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/verify-email/callback?emailChanged=1');
  });

  it('skips the callback for an unverified account, and leaves it unverified', async () => {
    const { response, db, afterEmailVerification } = await clickNewAddressLink({
      emailVerified: false,
    });

    expect(response.status).toBe(200);
    expect(db.user[0]?.email).toBe('new@example.com');
    expect(db.user[0]?.emailVerified).toBe(false);
    expect(afterEmailVerification).not.toHaveBeenCalled();
  });
});
