/**
 * Unit Tests: with BILLING_PROVIDER unset, billing is off everywhere (§139 t-1094)
 *
 * The done-when, in one place: every billing route answers that billing is
 * off, nothing reaches a provider or the database's billing tables, and the
 * `stripe` package is never evaluated. The REAL `lib/billing/config.ts`,
 * checkout and webhook modules; only the session guard is replaced, by one
 * that admits an org OWNER, so the off answer is the handler's and not a
 * refusal of who is asking.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mockEnv = vi.hoisted(() => ({
  TENANCY_MODE: 'multi',
  BILLING_PROVIDER: undefined,
  STRIPE_SECRET_KEY: 'sk_test_set_but_unused',
  STRIPE_WEBHOOK_SECRET: 'whsec_set_but_unused',
  BETTER_AUTH_URL: 'https://app.test',
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

const loaded = vi.hoisted(() => ({ stripe: false }));
vi.mock('stripe', () => {
  loaded.stripe = true;
  return { default: class {} };
});

const ORG = 'cmorg000000000000000other';
vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (req: unknown, session: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown, ctx: unknown) =>
      handler(
        req,
        {
          user: { id: 'cmjbv4i3x00003wsloputgwul', role: 'USER' },
          session: {},
          principal: { orgId: ORG, orgRole: 'OWNER', credential: 'session' },
        },
        ctx
      ),
}));
vi.mock('@/lib/auth/api-keys', () => ({ isApiKeySession: () => false }));

const db = vi.hoisted(() => ({
  touched: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, key) => {
        db.touched(key);
        throw new Error(`billing off must not reach prisma.${String(key)}`);
      },
    }
  ),
}));

import { POST as WEBHOOK } from '@/app/api/v1/billing/webhook/[provider]/route';
import { POST as CHECKOUT } from '@/app/api/v1/orgs/[id]/billing/checkout/route';
import { POST as PORTAL } from '@/app/api/v1/orgs/[id]/billing/portal/route';

describe('BILLING_PROVIDER unset', () => {
  it('every billing route says billing is off, and the stripe package is never loaded', async () => {
    const params = { params: Promise.resolve({ id: ORG }) };
    const answers = [
      await WEBHOOK(
        new Request('http://localhost/api/v1/billing/webhook/stripe', {
          method: 'POST',
          headers: { 'stripe-signature': 't=1,v1=x' },
          body: '{}',
        }) as unknown as NextRequest,
        { params: Promise.resolve({ provider: 'stripe' }) }
      ),
      await CHECKOUT(
        new Request(`http://localhost/api/v1/orgs/${ORG}/billing/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planKey: 'pro' }),
        }) as unknown as NextRequest,
        params
      ),
      await PORTAL(
        new Request(`http://localhost/api/v1/orgs/${ORG}/billing/portal`, {
          method: 'POST',
        }) as unknown as NextRequest,
        params
      ),
    ];

    expect(answers.map((res) => res.status)).toEqual([404, 409, 409]);
    const bodies = await Promise.all(
      answers.map(
        (res) =>
          res.json() as Promise<{ error: { message: string; details?: { reason?: string } } }>
      )
    );
    expect(bodies[0].error.message).toBe('Billing is not switched on for this install');
    expect(bodies[1].error.details?.reason).toBe('billing_off');
    expect(bodies[2].error.details?.reason).toBe('billing_off');
    expect(loaded.stripe).toBe(false);
    expect(db.touched).not.toHaveBeenCalled();
  });
});
