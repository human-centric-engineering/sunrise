/**
 * Tests: the maintenance tick's cron credential (#1130)
 *
 * `isMaintenanceCronRequest` decides, with no database, whether a request
 * carries `Authorization: Bearer <CRON_SECRET>`. It must fail closed: an unset
 * or short secret matches nothing, so the route falls through to the
 * admin-key guard.
 *
 * @see lib/orchestration/maintenance/cron-secret.ts
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  MIN_CRON_SECRET_LENGTH,
  __resetCronSecretWarningForTests,
  isMaintenanceCronRequest,
} from '@/lib/orchestration/maintenance/cron-secret';

const SECRET = 'q3Jx8m2Vt9Lw4Rz7Nc1Hb6Pk0Yd5Gf3S';

function request(authorization?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/maintenance/tick', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe('isMaintenanceCronRequest', () => {
  const saved = process.env.CRON_SECRET;
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCronSecretWarningForTests();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('accepts the exact bearer', () => {
    process.env.CRON_SECRET = SECRET;
    expect(isMaintenanceCronRequest(request(`Bearer ${SECRET}`))).toBe(true);
  });

  it('never matches an sk_ key, so revoking it or demoting its owner still stops it (#746)', () => {
    // The pre-#1130 setup. The admin-key guard verifies the key; this cannot.
    const key = `sk_${'0123456789abcdef'.repeat(4)}`;
    process.env.CRON_SECRET = key;
    expect(isMaintenanceCronRequest(request(`Bearer ${key}`))).toBe(false);
    // Still a supported setup, so nothing is logged for it.
    expect(logger.warn).not.toHaveBeenCalled(); // test-review:accept no_arg_called — an sk_ value is not misconfigured
  });

  it('never matches an SK_ value either, since the proxy looks one up whatever its case', () => {
    const upper = `SK_${'q3Jx8m2Vt9Lw4Rz7'.repeat(3)}`;
    process.env.CRON_SECRET = upper;
    expect(isMaintenanceCronRequest(request(`Bearer ${upper}`))).toBe(false);
    // No route accepts it, so the operator is told.
    expect(logger.warn).toHaveBeenCalledWith(
      'Maintenance tick: CRON_SECRET is set but ignored, because it starts with "sk_", which the rate limiter looks up as an API key',
      expect.any(Object)
    );
  });

  it.each([
    ['a trailing newline', `${SECRET}\n`],
    ['a leading space', ` ${SECRET}`],
  ])('ignores a CRON_SECRET with %s, even when the bearer matches it', (_label, padded) => {
    process.env.CRON_SECRET = padded;
    expect(isMaintenanceCronRequest(request(`Bearer ${padded}`))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('starts or ends with whitespace'),
      expect.any(Object)
    );
  });

  it.each([
    ['a different secret of the same length', `Bearer ${SECRET.slice(0, -1)}X`],
    ['the secret with a suffix', `Bearer ${SECRET}x`],
    ['a prefix of the secret', `Bearer ${SECRET.slice(0, 20)}`],
    ['a lower-case scheme', `bearer ${SECRET}`],
    ['no scheme', SECRET],
    ['an empty bearer', 'Bearer '],
  ])('refuses %s', (_label, header) => {
    process.env.CRON_SECRET = SECRET;
    expect(isMaintenanceCronRequest(request(header))).toBe(false);
  });

  it('refuses a request with no Authorization header', () => {
    process.env.CRON_SECRET = SECRET;
    expect(isMaintenanceCronRequest(request())).toBe(false);
  });

  it('matches nothing when CRON_SECRET is unset, an empty bearer included', () => {
    delete process.env.CRON_SECRET;
    expect(isMaintenanceCronRequest(request('Bearer '))).toBe(false);
    expect(isMaintenanceCronRequest(request(`Bearer ${SECRET}`))).toBe(false);
  });

  it('matches nothing when CRON_SECRET is empty', () => {
    process.env.CRON_SECRET = '';
    expect(isMaintenanceCronRequest(request('Bearer '))).toBe(false);
  });

  it(`ignores a CRON_SECRET shorter than ${MIN_CRON_SECRET_LENGTH} characters, even when the bearer matches`, () => {
    const short = SECRET.slice(0, MIN_CRON_SECRET_LENGTH - 1);
    process.env.CRON_SECRET = short;
    expect(isMaintenanceCronRequest(request(`Bearer ${short}`))).toBe(false);
  });

  it('says once per process why a set CRON_SECRET is ignored, since the cron only sees a 401', () => {
    process.env.CRON_SECRET = 'too-short';
    isMaintenanceCronRequest(request('Bearer too-short'));
    isMaintenanceCronRequest(request('Bearer too-short'));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      `Maintenance tick: CRON_SECRET is set but ignored, because it is shorter than ${MIN_CRON_SECRET_LENGTH} characters`,
      { hint: 'Set CRON_SECRET to a random value: openssl rand -base64 32' }
    );
  });

  it('logs nothing for a request with no bearer, whatever CRON_SECRET holds', () => {
    process.env.CRON_SECRET = 'too-short';
    expect(isMaintenanceCronRequest(request())).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled(); // test-review:accept no_arg_called — only a cron request is worth a warning
  });

  it(`honours a CRON_SECRET of exactly ${MIN_CRON_SECRET_LENGTH} characters`, () => {
    const exact = SECRET.slice(0, MIN_CRON_SECRET_LENGTH);
    process.env.CRON_SECRET = exact;
    expect(isMaintenanceCronRequest(request(`Bearer ${exact}`))).toBe(true);
  });
});
