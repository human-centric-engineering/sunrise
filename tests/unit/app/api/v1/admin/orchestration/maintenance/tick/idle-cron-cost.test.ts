/**
 * Tests: what an idle cron tick costs the database (#1130)
 *
 * The idle gate (#442) lets an idle tick answer with no query, so a
 * scale-to-zero database can suspend. That only holds if nothing on the way to
 * the gate queries either. This drives a Vercel Cron request through what runs
 * before the tick: the proxy's rate-limit dispatcher (`applyRateLimit`), then
 * the route's GET with its real guard and real `resolveApiKey`. Prisma is a
 * recorder: any model a query reaches is noted, and the test asserts on the
 * list.
 *
 * better-auth is real too, over the same recorder: the proxy's cookie-keyed
 * rule calls `auth.api.getSession`, so a better-auth change that read the
 * bearer (a `bearer` or `jwt` plugin) would show up here as a query.
 *
 * The contrast cases are what make the zero mean something: an `sk_` bearer is
 * looked up, and the recorder sees it.
 *
 * @see lib/orchestration/maintenance/cron-secret.ts
 * @see lib/security/rate-limit-middleware.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/** Every Prisma model a query reached, in order. */
const touched = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/db/client', () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: () =>
          vi.fn(async () => {
            touched.push(name);
            return null;
          }),
      }
    );
  return {
    prisma: new Proxy({}, { get: (_target, name) => model(String(name)) }),
  };
});

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/logging', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...logger, child: () => logger } };
});

const tenancy = vi.hoisted(() => ({ mode: 'single' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'TENANCY_MODE' ? tenancy.mode : (Reflect.get(target, key) as unknown),
    }),
  };
});

import { auth } from '@/lib/auth/config';
import { applyRateLimit } from '@/lib/security/rate-limit-middleware';
import { resetRateLimitCredentialCache } from '@/lib/security/rate-limit-credentials';
import { __resetIdleGateForTests, armIdleGate } from '@/lib/orchestration/maintenance/idle-gate';
import { GET } from '@/app/api/v1/admin/orchestration/maintenance/tick/route';

const TICK = 'http://localhost:3000/api/v1/admin/orchestration/maintenance/tick';
const RANDOM_SECRET = 'q3Jx8m2Vt9Lw4Rz7Nc1Hb6Pk0Yd5Gf3S';
const SK_SECRET = `sk_${'a'.repeat(64)}`;

let ipSeq = 0;

/** A Vercel Cron request: a GET with the bearer, from a fresh IP so no bucket carries over. */
function cronRequest(bearer: string): NextRequest {
  return new NextRequest(TICK, {
    method: 'GET',
    headers: { authorization: `Bearer ${bearer}`, 'x-forwarded-for': `10.9.0.${++ipSeq}` },
  });
}

/** The proxy, then the route: everything a cron request meets before the gate answers. */
async function callTick(bearer: string): Promise<Response> {
  const request = cronRequest(bearer);
  const limited = await applyRateLimit(request);
  expect(limited).toBeNull();
  return GET(request);
}

describe('an idle cron tick (#1130)', () => {
  const savedSecret = process.env.CRON_SECRET;
  const savedBypass = process.env.RATE_LIMIT_BYPASS;

  beforeEach(() => {
    touched.length = 0;
    // tests/setup.ts bypasses rate limiting; the dispatcher is what is measured here.
    delete process.env.RATE_LIMIT_BYPASS;
    // Each request also comes from a fresh IP (`cronRequest`), so no
    // credential-lookup budget carries over between cases.
    resetRateLimitCredentialCache();
    __resetIdleGateForTests();
    // What a previous sweep that found nothing leaves behind.
    armIdleGate({ now: Date.now(), nextWorkAtMs: null });
  });

  afterEach(() => {
    process.env.CRON_SECRET = savedSecret;
    process.env.RATE_LIMIT_BYPASS = savedBypass;
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    if (savedBypass === undefined) delete process.env.RATE_LIMIT_BYPASS;
  });

  describe.each(['single', 'multi'] as const)('at TENANCY_MODE=%s', (mode) => {
    beforeEach(() => {
      tenancy.mode = mode;
    });

    it('makes no query when authenticated by a random CRON_SECRET', async () => {
      process.env.CRON_SECRET = RANDOM_SECRET;
      // Watched, not replaced: the real better-auth must run and still not query.
      const getSession = vi.spyOn(auth.api, 'getSession');

      const response = await callTick(RANDOM_SECRET);
      const body = (await response.json()) as { data: { skipped: boolean; reason: string } };

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({ skipped: true, reason: 'idle' });
      expect(getSession).toHaveBeenCalled();
      expect(touched).toEqual([]);
    });

    it('sends an sk_ CRON_SECRET through the admin-key check, which queries', async () => {
      // The pre-#1130 setup. The secret check refuses an sk_ value, so the
      // guard can still refuse a revoked key (#746); that costs the proxy's
      // lookup and `resolveApiKey`'s. Unknown to the recorder, so 401.
      process.env.CRON_SECRET = SK_SECRET;

      const request = cronRequest(SK_SECRET);
      expect(await applyRateLimit(request)).toBeNull();
      const response = await GET(request);

      expect(response.status).toBe(401);
      expect(touched.filter((m) => m === 'aiApiKey').length).toBeGreaterThanOrEqual(2);
    });

    it('looks up an admin API key on the old path, before the gate can answer', async () => {
      // No CRON_SECRET: the route falls through to `withAdminAuth`, whose
      // `resolveApiKey` reads the key row, after the proxy's own lookup.
      delete process.env.CRON_SECRET;

      const request = cronRequest(SK_SECRET);
      expect(await applyRateLimit(request)).toBeNull();
      const response = await GET(request);

      expect(response.status).toBe(401);
      expect(touched.filter((m) => m === 'aiApiKey').length).toBeGreaterThanOrEqual(2);
    });
  });
});
