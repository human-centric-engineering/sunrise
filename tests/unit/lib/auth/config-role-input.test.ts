/**
 * Tests: `role` is not client-settable at sign-up
 *
 * better-auth's sign-up handler passes every declared `additionalField`
 * through `parseUserInput` from the request body unless the field says
 * `input: false`. Sunrise declared `role` without it, so an unauthenticated
 * `POST /api/auth/sign-up/email` carrying `"role": "ADMIN"` created a platform
 * admin on any open-signup install — verified live on 2026-09-17, not inferred.
 *
 * This runs better-auth's OWN parser over the REAL auth options, rather than a
 * mock of either: a mocked `betterAuth` (which every other config test uses)
 * cannot see what the real one does with the body, and a test of the mock
 * would have been green throughout the defect. The control case below feeds the
 * same parser the same options with `input: false` removed and asserts the
 * escalation comes back — which is what proves the first assertion is doing
 * work, not passing on an empty parse.
 *
 * What it deliberately does NOT cover: the two legitimate role writers that
 * bypass the parser — `userCreateBeforeHook`'s bootstrap / invitation returns
 * (`config-database-hook.test.ts`, "first user on a fresh database") and the
 * `prisma.user.update` in `accept-invite` — because `input: false` cannot reach
 * them, and the existing tests already prove they still promote.
 *
 * @see lib/auth/config.ts — the `role` additional field
 */
import { describe, it, expect, vi } from 'vitest';
import { parseUserInput } from 'better-auth/db';
import { PLATFORM_ADMIN_ROLE, DEFAULT_USER_ROLE } from '@/lib/auth/roles';

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    BETTER_AUTH_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    EMAIL_FROM: 'test@example.com',
    SIGNUP_MODE: 'open',
  },
  isProduction: () => false,
  isDevelopment: () => false,
  isTest: () => true,
}));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ validateEmailConfig: vi.fn() }));

const { auth } = await import('@/lib/auth/config');

/** The body a sign-up request carries once the handler has peeled off the known keys. */
const hostileBody = { role: PLATFORM_ADMIN_ROLE };

describe('role at sign-up', () => {
  it('declares the field as not client-settable', () => {
    expect(auth.options.user?.additionalFields?.role).toMatchObject({ input: false });
  });

  it("replaces a body's role: ADMIN with the default — better-auth's own parser, real options", () => {
    const parsed = parseUserInput(auth.options, hostileBody, 'create');
    expect(parsed.role).toBe(DEFAULT_USER_ROLE);
  });

  it('refuses role on update — the signed-in self-promotion path via /update-user', () => {
    // `update-user.mjs` runs the same parser with action 'update'; there the
    // guard is a 400 rather than a silent default, because there is no
    // defaultValue arm on update.
    expect(() => parseUserInput(auth.options, hostileBody, 'update')).toThrow(
      /role is not allowed to be set/
    );
  });

  it('still accepts the one update body Sunrise sends — { image } alone', () => {
    expect(() =>
      parseUserInput(auth.options, { image: 'https://x/y.png' }, 'update')
    ).not.toThrow();
  });

  it('control: with input: false removed, the same parser hands the body its ADMIN', () => {
    // The assertion above is only evidence if this one is red. Same parser,
    // same body; the one difference is the line the fix added.
    const { input: _removed, ...roleWithoutGuard } = auth.options.user.additionalFields.role;
    const weakened = {
      ...auth.options,
      user: { ...auth.options.user, additionalFields: { role: roleWithoutGuard } },
    };
    const parsed = parseUserInput(weakened, hostileBody, 'create');
    expect(parsed.role).toBe(PLATFORM_ADMIN_ROLE);
    expect(parseUserInput(weakened, hostileBody, 'update').role).toBe(PLATFORM_ADMIN_ROLE);
  });
});

// t-838: the signup record names the org the sign-in self-heal writes a
// membership into, so a body-settable value would let anyone sign up into any
// org. Same parser, same real options, same control as `role` above.
describe('the signup record at sign-up and on update (t-838)', () => {
  const victimOrg = 'cmorg000000000000000victm';

  it('declares both fields as not client-settable and not returned', () => {
    for (const field of ['signupOrgId', 'signupOrgRole'] as const) {
      expect(auth.options.user?.additionalFields?.[field]).toMatchObject({
        input: false,
        returned: false,
      });
    }
  });

  it('refuses a body-supplied record on create', () => {
    // With no defaultValue there is no silent-replace arm, so the sign-up is a
    // 400 rather than an account created with the field dropped.
    expect(() => parseUserInput(auth.options, { signupOrgId: victimOrg }, 'create')).toThrow(
      /signupOrgId is not allowed to be set/
    );
    expect(() => parseUserInput(auth.options, { signupOrgRole: 'OWNER' }, 'create')).toThrow(
      /signupOrgRole is not allowed to be set/
    );
  });

  it('refuses a body-supplied record on update', () => {
    expect(() => parseUserInput(auth.options, { signupOrgId: victimOrg }, 'update')).toThrow(
      /signupOrgId is not allowed to be set/
    );
    expect(() => parseUserInput(auth.options, { signupOrgRole: 'OWNER' }, 'update')).toThrow(
      /signupOrgRole is not allowed to be set/
    );
  });

  it('control: with input: false removed, the same parser hands the body its org', () => {
    const fields = auth.options.user?.additionalFields;
    const { input: _input, ...open } = fields?.signupOrgId ?? { type: 'string' as const };
    const unsafe = {
      ...auth.options,
      user: { ...auth.options.user, additionalFields: { ...fields, signupOrgId: open } },
    };
    expect(parseUserInput(unsafe, { signupOrgId: victimOrg }, 'create').signupOrgId).toBe(
      victimOrg
    );
  });
});
