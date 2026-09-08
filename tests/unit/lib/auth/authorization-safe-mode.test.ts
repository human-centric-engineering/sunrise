/**
 * Tests: a fork whose `initAppAuthorizationPolicy()` throws
 *
 * Its own file because the seam is bound at module scope — the gate captures
 * `initAppAuthorizationPolicy` when `lib/auth/authorization.ts` is first
 * evaluated, so making it throw needs a hoisted module mock, and a mock that
 * throws for every test in a file is not something the main suite can share.
 *
 * The property under test is a decision, not a mechanism: Sunrise does **not**
 * fall back to its own default policy when a fork's registration fails. A fork
 * policy usually NARROWS the default (an org admin must not see another org's
 * rows), so falling back would widen access under a log line saying the feature
 * had been disabled — the seven-seams defect of #633 wearing an authorization
 * costume. Safe mode closes the admin surface instead, loudly.
 *
 * @see lib/auth/authorization.ts — SAFE_MODE_POLICY and the `onFailure` hook
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@/lib/app/authorization', () => ({
  initAppAuthorizationPolicy: () => {
    throw new Error('the fork’s policy module blew up');
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  SAFE_MODE_POLICY,
  DEFAULT_AUTHORIZATION_POLICY,
  getAuthorizationPolicy,
  canAdminister,
  canRead,
  readSubject,
  subjectScope,
  __resetAuthorizationPolicyForTests,
  type AuthorizationPrincipal,
} from '@/lib/auth/authorization';
import { logger } from '@/lib/logging';

const ADMIN: AuthorizationPrincipal = { userId: 'admin-1', role: 'ADMIN', credential: 'session' };

afterEach(() => {
  __resetAuthorizationPolicyForTests();
  vi.clearAllMocks();
});

describe('a throwing app registration', () => {
  it('runs safe mode, not the Sunrise default', () => {
    expect(getAuthorizationPolicy()).toBe(SAFE_MODE_POLICY);
    // Stated as a distinct assertion because "not the default" is the whole
    // decision. Rolling back to the default is what the gate does to the
    // REGISTRY, and it is the wrong answer for a policy.
    expect(getAuthorizationPolicy()).not.toBe(DEFAULT_AUTHORIZATION_POLICY);
  });

  it('closes the admin surface to a platform admin', async () => {
    // The cost of the decision, stated where it can be read: this is an outage,
    // and it is preferred to a silent widening.
    await expect(canAdminister(ADMIN)).resolves.toBe(false);
  });

  it('narrows declared reads to the reader, and leaves undeclared ones alone', async () => {
    await expect(canRead(ADMIN, readSubject('user-9'))).resolves.toBe(false);
    await expect(canRead(ADMIN, readSubject('admin-1'))).resolves.toBe(true);
    await expect(canRead(ADMIN, { kind: 'nothing' })).resolves.toBe(true);
    await expect(subjectScope(ADMIN)).resolves.toEqual({ userId: 'admin-1' });
  });

  it('says what it did, beyond the gate’s own "disabled" line', () => {
    getAuthorizationPolicy();

    const messages = vi.mocked(logger.error).mock.calls.map((call) => String(call[0]));
    // The gate's line reads "rolled back and disabled", which for every other
    // seam means a feature is missing. Here it means the console is refusing
    // everyone, and an operator reading 403s deserves to find that sentence.
    expect(messages).toContain(
      'authorization: the app policy failed to register — running in SAFE MODE'
    );
  });

  it('stays in safe mode rather than retrying the broken registration', () => {
    getAuthorizationPolicy();
    vi.mocked(logger.error).mockClear();

    expect(getAuthorizationPolicy()).toBe(SAFE_MODE_POLICY);
    // The gate latches before it runs, so a throwing init is not re-entered.
    // Without that, every guarded request in the process would re-pay the
    // failure and re-log it.
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });
});
