/**
 * Tests: a fork whose `initAppAuthorizationPolicy()` is async (#739)
 *
 * Its own file for the same reason as `authorization-safe-mode.test.ts`: the
 * seam is bound at module scope, so changing its shape needs a hoisted mock.
 *
 * An async init returns a promise, which the gate used to read as success:
 * `'ok'` the instant the call returned, the policy it registered before its
 * first `await` left live, and a later rejection never reaching `onFailure` —
 * the only thing that selects safe mode. So an install whose fork policy init
 * was async ran Sunrise's widest default policy with nothing reporting it. The
 * gate now refuses the shape, and these pin what that means for authorization.
 *
 * @see lib/fork-init.ts — `refuseAsync`
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const seam = vi.hoisted(() => ({ registerBeforeAwait: (): void => {} }));

vi.mock('@/lib/app/authorization', () => ({
  // Registers before its first await, then rejects — the shape that was worst
  // before: a policy in place, and a failure nothing acted on.
  initAppAuthorizationPolicy: async () => {
    seam.registerBeforeAwait();
    await Promise.resolve();
    throw new Error('the fork’s policy lookup failed');
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  SAFE_MODE_POLICY,
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  getAuthorizationPolicy,
  hasAppAuthorizationPolicy,
  canAdminister,
  __resetAuthorizationPolicyForTests,
  type AuthorizationPrincipal,
} from '@/lib/auth/authorization';
import { logger } from '@/lib/logging';

const ADMIN: AuthorizationPrincipal = { userId: 'admin-1', role: 'ADMIN', credential: 'session' };

// A copy, so "the fork's policy" is distinguishable from the default by identity.
seam.registerBeforeAwait = () => registerAuthorizationPolicy({ ...DEFAULT_AUTHORIZATION_POLICY });

afterEach(() => {
  __resetAuthorizationPolicyForTests();
  vi.clearAllMocks();
});

describe('an async app registration', () => {
  it('runs safe mode, and drops the policy it registered before its first await', async () => {
    expect(getAuthorizationPolicy()).toBe(SAFE_MODE_POLICY);
    expect(hasAppAuthorizationPolicy()).toBe(false);
    await expect(canAdminister(ADMIN)).resolves.toBe(false);
  });

  it('says so in the safe-mode words, not only the gate’s', () => {
    getAuthorizationPolicy();

    const messages = vi.mocked(logger.error).mock.calls.map((call) => String(call[0]));
    expect(messages).toContain(
      'authorization: the app policy failed to register — running in SAFE MODE'
    );
  });
});
