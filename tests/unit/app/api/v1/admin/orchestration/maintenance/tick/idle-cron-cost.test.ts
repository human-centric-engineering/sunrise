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
 * `auth.api.getSession` is mocked to "no session". The proxy calls it on the
 * cookie-keyed rule, and better-auth returns null without a database read when
 * the request carries no session cookie (`api/routes/session.mjs`: no signed
 * session cookie → `return null`), which is what a cron request is.
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

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn(async () => null) } } }));

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

import { applyRateLimit } from '@/lib/security/rate-limit-middleware';
import {
  resetRateLimitCredentialBudget,
  resetRateLimitCredentialCache,
} from '@/lib/security/rate-limit-credentials';
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
    resetRateLimitCredentialCache();
    resetRateLimitCredentialBudget('10.9.0.0');
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

      const response = await callTick(RANDOM_SECRET);
      const body = (await response.json()) as { data: { skipped: boolean; reason: string } };

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({ skipped: true, reason: 'idle' });
      expect(touched).toEqual([]);
    });

    it('still pays the proxy’s key lookup when CRON_SECRET is an sk_ key', async () => {
      // The contrast that shows the recorder sees a query: the proxy's
      // orchestration rule looks up any `Bearer sk_…`. The route itself
      // matches the secret without one, so the lookup is the proxy's.
      process.env.CRON_SECRET = SK_SECRET;

      const response = await callTick(SK_SECRET);

      expect(response.status).toBe(200);
      expect(touched).toEqual(['aiApiKey']);
    });

    it('looks up an admin API key on the old path, before the gate can answer', async () => {
      // No CRON_SECRET: the route falls through to `withAdminAuth`, whose
      // `resolveApiKey` reads the key row. Unknown here, so 401 after a query.
      delete process.env.CRON_SECRET;

      const request = cronRequest(SK_SECRET);
      await applyRateLimit(request);
      const response = await GET(request);

      expect(response.status).toBe(401);
      expect(touched).toContain('aiApiKey');
      expect(touched.filter((m) => m === 'aiApiKey').length).toBeGreaterThanOrEqual(2);
    });
  });
});
