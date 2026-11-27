/**
 * Tests: lib/billing/signup-plan.ts — a plan chosen at signup (§139 t-1096).
 *
 * - `signupPlanOf` / `signupPlanOffer`: only a registered plan's key, only
 *   while billing is on; anything else is dropped.
 * - `takeUpSignupPlan`: a free plan is applied and then removed; a paid one
 *   is left for the founder's first visit by the org's setup (`paid: false`)
 *   and, from the billing page (`paid: true`), removed and sent to checkout.
 *   Nothing happens while the org awaits its founder or billing is off; a
 *   key the app no longer registers is dropped.
 *
 * The settings slice's own read-modify-write is org-settings.test.ts; here it
 * is mocked at the module, with what it is asked to take asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const state = vi.hoisted(() => ({ billingOn: true, plansFailed: false }));
vi.mock('@/lib/billing/config', () => ({ billingEnabled: () => state.billingOn }));

const FREE = { key: 'starter', label: 'Starter', priceLookupKey: null };
const PRO = { key: 'pro', label: 'Pro', priceLookupKey: 'pro_monthly' };
vi.mock('@/lib/billing/plans', () => ({
  billingPlansFailed: () => state.plansFailed,
  planOf: (key: string) => ({ starter: FREE, pro: PRO })[key],
}));

const errors = vi.hoisted(() => ({
  BillingPlanError: class BillingPlanError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  },
}));
const mockAssignPlan = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/subscriptions', () => ({
  assignPlan: mockAssignPlan,
  BillingPlanError: errors.BillingPlanError,
}));
const mockStartCheckout = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/checkout', () => ({ startCheckout: mockStartCheckout }));

const db = vi.hoisted(() => ({ org: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const mockTake = vi.hoisted(() => vi.fn());
const mockRestore = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/org-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/org-settings')>()),
  takeOrgSignupPlan: mockTake,
  restoreOrgSignupPlan: mockRestore,
}));

const mockAudit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: mockAudit }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyFreeSignupPlan,
  signupPlanOf,
  signupPlanOffer,
  takeUpSignupPlan,
} from '@/lib/billing/signup-plan';
import { logger } from '@/lib/logging';

const ORG = 'cmorg00000000000000signup';
const FOUNDER = 'cmuser0000000000000founder';

function waiting(planKey: string | null, extra: Record<string, unknown> = {}) {
  db.org.findUnique.mockResolvedValue({
    settings: planKey === null ? extra : { signupPlan: planKey, ...extra },
  });
}

/** What the real slice would take: the waiting key, when `accept` agrees. */
function takeAsStored(planKey: string) {
  mockTake.mockImplementation(async (_orgId: string, accept: (key: string) => boolean) =>
    accept(planKey) ? planKey : null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.billingOn = true;
  state.plansFailed = false;
  mockAssignPlan.mockResolvedValue({ changed: true, previousPlanKey: null });
  mockStartCheckout.mockResolvedValue({ url: 'https://checkout.example/c/1' });
});

describe('signupPlanOf', () => {
  it('answers the registered plan a key names', () => {
    expect(signupPlanOf('pro')).toBe(PRO);
    expect(signupPlanOf('starter')).toBe(FREE);
  });

  it('drops a key no plan has, a value that is not a key, and nothing at all', () => {
    expect(signupPlanOf('platinum')).toBeNull();
    expect(signupPlanOf('Pro Plan')).toBeNull();
    expect(signupPlanOf(['pro'])).toBeNull();
    expect(signupPlanOf(undefined)).toBeNull();
    expect(signupPlanOf('')).toBeNull();
  });

  it('drops every key while billing is off', () => {
    state.billingOn = false;
    expect(signupPlanOf('pro')).toBeNull();
  });

  it('offers the page a label and whether checkout follows', () => {
    expect(signupPlanOffer('pro')).toEqual({ key: 'pro', label: 'Pro', paid: true });
    expect(signupPlanOffer('starter')).toEqual({ key: 'starter', label: 'Starter', paid: false });
    expect(signupPlanOffer('platinum')).toBeNull();
  });
});

describe('takeUpSignupPlan — a free plan', () => {
  it('removes it, then applies it, and audits it as the founder’s', async () => {
    waiting('starter');
    takeAsStored('starter');

    const result = await takeUpSignupPlan(ORG, { paid: false, actorUserId: FOUNDER });

    expect(result).toEqual({ kind: 'applied', planKey: 'starter' });
    expect(mockAssignPlan).toHaveBeenCalledWith(ORG, 'starter');
    expect(mockTake.mock.invocationCallOrder[0]).toBeLessThan(
      mockAssignPlan.mock.invocationCallOrder[0]
    );
    expect(mockStartCheckout).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: FOUNDER,
        action: 'org.plan.assign',
        entityId: ORG,
        changes: { plan: { from: null, to: 'starter' } },
        metadata: { source: 'signup' },
      })
    );
  });

  it('puts it back when applying it fails, so the next caller tries again', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(new Error('lock wait timeout'));

    await expect(takeUpSignupPlan(ORG, { paid: false, actorUserId: FOUNDER })).rejects.toThrow(
      'lock wait timeout'
    );
    expect(mockRestore).toHaveBeenCalledWith(ORG, 'starter');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('applies nothing when another caller took it first', async () => {
    waiting('starter');
    mockTake.mockResolvedValue(null);

    expect(await takeUpSignupPlan(ORG, { paid: false, actorUserId: FOUNDER })).toEqual({
      kind: 'none',
    });
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('applies it even while a hook stays owed, so it never waits on a hook that keeps failing', async () => {
    waiting('starter', { orgCreated: { owed: ['app.removed'], source: 'signup' } });
    takeAsStored('starter');

    expect(await takeUpSignupPlan(ORG, { paid: false, actorUserId: FOUNDER })).toEqual({
      kind: 'applied',
      planKey: 'starter',
    });
  });

  it('writes no audit row when the org was already on it', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockResolvedValue({ changed: false, previousPlanKey: 'starter' });

    await takeUpSignupPlan(ORG, { paid: false, actorUserId: FOUNDER });

    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('takeUpSignupPlan — a paid plan', () => {
  it('is left waiting by the org’s setup, for the founder’s first visit', async () => {
    waiting('pro');

    const result = await takeUpSignupPlan(ORG, { paid: false, actorUserId: FOUNDER });

    expect(result).toEqual({ kind: 'none' });
    expect(mockTake).not.toHaveBeenCalled();
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });

  it('is removed, then sent to checkout for that plan, from the billing page', async () => {
    waiting('pro');
    takeAsStored('pro');

    const result = await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER });

    expect(result).toEqual({
      kind: 'checkout',
      planKey: 'pro',
      url: 'https://checkout.example/c/1',
    });
    expect(mockTake.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartCheckout.mock.invocationCallOrder[0]
    );
    expect(mockStartCheckout).toHaveBeenCalledWith(ORG, 'pro');
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('starts no checkout when another caller took it first', async () => {
    waiting('pro');
    mockTake.mockResolvedValue(null);

    expect(await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).toEqual({
      kind: 'none',
    });
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });

  it('throws the checkout’s refusal for the route to answer, with the plan already taken', async () => {
    waiting('pro');
    takeAsStored('pro');
    mockStartCheckout.mockRejectedValue(new Error('PRICE_MISSING'));

    await expect(takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).rejects.toThrow(
      'PRICE_MISSING'
    );
    expect(mockTake).toHaveBeenCalledTimes(1);
  });
});

describe('takeUpSignupPlan — nothing to do', () => {
  it('answers none when nothing is waiting, or there is no such org', async () => {
    waiting(null);
    expect(await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).toEqual({
      kind: 'none',
    });
    db.org.findUnique.mockResolvedValue(null);
    expect(await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).toEqual({
      kind: 'none',
    });
    expect(mockTake).not.toHaveBeenCalled();
  });

  it('does nothing while the org still awaits its founder: the app’s setup has not run', async () => {
    waiting('starter', { awaitingFounder: true });

    expect(await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).toEqual({
      kind: 'none',
    });
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('leaves it waiting while billing is off', async () => {
    waiting('pro');
    state.billingOn = false;

    expect(await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).toEqual({
      kind: 'none',
    });
    expect(mockTake).not.toHaveBeenCalled();
  });

  it('leaves it waiting while the app’s plans failed to register, rather than drop a valid choice', async () => {
    waiting('pro');
    state.plansFailed = true;

    expect(await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).toEqual({
      kind: 'none',
    });
    expect(mockTake).not.toHaveBeenCalled();
  });

  it('drops a key the app no longer registers, logged', async () => {
    waiting('legacy');
    takeAsStored('legacy');

    expect(await takeUpSignupPlan(ORG, { paid: false, actorUserId: FOUNDER })).toEqual({
      kind: 'dropped',
      planKey: 'legacy',
    });
    expect(mockAssignPlan).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no longer registered'),
      expect.objectContaining({ orgId: ORG, planKey: 'legacy' })
    );
  });

  it('tries a take that clashed with another settings write again', async () => {
    waiting('pro');
    const clash = new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    mockTake.mockRejectedValueOnce(clash).mockResolvedValueOnce('pro');

    const result = await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER });

    expect(result.kind).toBe('checkout');
    expect(mockTake).toHaveBeenCalledTimes(2);
  });
});

describe('applyFreeSignupPlan', () => {
  it('never throws: a failure is logged at error', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(new Error('boom'));

    await expect(applyFreeSignupPlan(ORG, FOUNDER)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not apply'),
      expect.any(Error),
      { orgId: ORG }
    );
  });
});

describe('takeUpSignupPlan — a take-up that fails part-way', () => {
  it('drops a free plan the org can no longer take, since the provider manages its plan', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(
      new errors.BillingPlanError('PROVIDER_MANAGED', 'The provider manages this plan')
    );

    expect(await takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).toEqual({
      kind: 'none',
    });
    expect(mockTake).toHaveBeenCalledTimes(1);
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not put a paid plan back after any checkout failure: a later visit would start one unasked', async () => {
    waiting('pro');
    takeAsStored('pro');
    mockStartCheckout.mockRejectedValue(new Error('provider 503'));

    await expect(takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).rejects.toThrow(
      'provider 503'
    );
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('tries a put-back that clashed with another settings write again', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(new Error('lock wait timeout'));
    const clash = new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    mockRestore.mockRejectedValueOnce(clash).mockResolvedValueOnce(true);

    await expect(takeUpSignupPlan(ORG, { paid: false, actorUserId: FOUNDER })).rejects.toThrow(
      'lock wait timeout'
    );
    expect(mockRestore).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still rethrows the assignment failure when putting the plan back fails too', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(new Error('lock wait timeout'));
    mockRestore.mockRejectedValue(new Error('database gone'));

    await expect(takeUpSignupPlan(ORG, { paid: true, actorUserId: FOUNDER })).rejects.toThrow(
      'lock wait timeout'
    );
    expect(logger.error).toHaveBeenCalledWith(
      'billing: could not put back the plan chosen at signup',
      expect.any(Error),
      { orgId: ORG, planKey: 'starter' }
    );
  });
});
