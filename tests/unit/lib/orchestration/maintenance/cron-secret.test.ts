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

import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  MIN_CRON_SECRET_LENGTH,
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
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('accepts the exact bearer', () => {
    process.env.CRON_SECRET = SECRET;
    expect(isMaintenanceCronRequest(request(`Bearer ${SECRET}`))).toBe(true);
  });

  it('accepts an sk_ key set as the secret, so existing Vercel setups keep working', () => {
    const key = `sk_${'0123456789abcdef'.repeat(4)}`;
    process.env.CRON_SECRET = key;
    expect(isMaintenanceCronRequest(request(`Bearer ${key}`))).toBe(true);
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

  it(`honours a CRON_SECRET of exactly ${MIN_CRON_SECRET_LENGTH} characters`, () => {
    const exact = SECRET.slice(0, MIN_CRON_SECRET_LENGTH);
    process.env.CRON_SECRET = exact;
    expect(isMaintenanceCronRequest(request(`Bearer ${exact}`))).toBe(true);
  });
});
