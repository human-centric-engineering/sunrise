/**
 * Tests: lib/billing/signup-plan.ts — a plan chosen at signup (§139 t-1096).
 *
 * - `signupPlanOf` / `signupPlanOffer`: only a registered plan's key, only
 *   while billing is on; anything else is dropped.
 * - A free plan is part of the org's setup: removed then applied, only once
 *   no hook this process runs is owed; put back when the assignment fails;
 *   dropped when the provider manages the org's plan. The sweep applies the
 *   ones setup could not.
 * - A paid plan is the owner's to start: the take-up answers its checkout and
 *   leaves it waiting, for the billing page to offer again; a subscription
 *   settles it. `dismissSignupPlan` removes it.
 * - Where a signup goes on to: the paid plan's checkout page, for the form,
 *   OAuth and the verification link (`signupContinuationForUser`).
 * - Nothing happens while the org awaits its founder, billing is off or the
 *   app's plans failed to register; a key the app no longer registers is
 *   dropped.
 *
 * The settings slice's own read-modify-write is org-settings.test.ts; here it
 * is mocked at the module, with what it is asked to take asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const state = vi.hoisted(() => ({ billingOn: true, plansFailed: false }));
vi.mock('@/lib/billing/config', () => ({ billingEnabled: () => state.billingOn }));

const FREE = { key: 'starter', label: 'Starter', priceLookupKey: null, availableAtSignup: true };
const PRO = { key: 'pro', label: 'Pro', priceLookupKey: 'pro_monthly', availableAtSignup: true };
/** Unpriced and not offered at signup: assigned by hand, invoiced offline. */
const ENTERPRISE = {
  key: 'enterprise',
  label: 'Enterprise',
  priceLookupKey: null,
  availableAtSignup: false,
};
vi.mock('@/lib/billing/plans', () => ({
  billingPlansFailed: () => state.plansFailed,
  planOf: (key: string) => ({ starter: FREE, pro: PRO, enterprise: ENTERPRISE })[key],
  registeredPlans: () => [FREE, PRO, ENTERPRISE],
}));

const hooks = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('@/lib/tenancy/org-created-hooks', () => ({ orgCreatedHookKeys: () => hooks.keys }));

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
const mockLoadSubscription = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/subscriptions', () => ({
  assignPlan: mockAssignPlan,
  loadOrgSubscription: mockLoadSubscription,
  BillingPlanError: errors.BillingPlanError,
}));
const mockStartCheckout = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/checkout', () => ({ startCheckout: mockStartCheckout }));

const db = vi.hoisted(() => ({
  org: { findUnique: vi.fn() },
  orgMembership: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
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
  applyWaitingFreeSignupPlans,
  dismissSignupPlan,
  pendingSignupPlan,
  signupContinuation,
  signupContinuationForUser,
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
  hooks.keys = [];
  mockLoadSubscription.mockResolvedValue(null);
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

  it('drops a plan the app does not offer at signup, such as one assigned by hand', () => {
    expect(signupPlanOf('enterprise')).toBeNull();
    expect(signupPlanOffer('enterprise')).toBeNull();
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

describe('where a signup goes on to', () => {
  it('goes on to the checkout page for a paid plan, and to the landing route otherwise', () => {
    expect(signupContinuation(signupPlanOffer('pro'))).toBe('/admin/billing?signup=plan');
    expect(signupContinuation(signupPlanOffer('starter'))).toBeNull();
    expect(signupContinuation(null)).toBeNull();
  });

  function owns(...settings: unknown[]) {
    db.orgMembership.findMany.mockResolvedValue(settings.map((s) => ({ org: { settings: s } })));
  }

  it('sends a verification link on to checkout when an org the person owns waits on a paid plan', async () => {
    // Still awaiting its founder when the link is sent: that does not matter here.
    owns({ signupPlan: 'pro', awaitingFounder: true });

    expect(await signupContinuationForUser(FOUNDER)).toBe('/admin/billing?signup=plan');
    expect(db.orgMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: FOUNDER, role: 'OWNER' } })
    );
  });

  it('sends it to the landing route for a free plan, an unknown one, or no org waiting', async () => {
    owns({ signupPlan: 'starter' });
    expect(await signupContinuationForUser(FOUNDER)).toBeNull();

    owns({ signupPlan: 'legacy' });
    expect(await signupContinuationForUser(FOUNDER)).toBeNull();

    owns();
    expect(await signupContinuationForUser(FOUNDER)).toBeNull();
  });

  it('never throws: a failed read sends the link to the landing route', async () => {
    db.orgMembership.findMany.mockRejectedValue(new Error('db down'));

    expect(await signupContinuationForUser(FOUNDER)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('answers nothing while billing is off', async () => {
    state.billingOn = false;

    expect(await signupContinuationForUser(FOUNDER)).toBeNull();
    expect(db.orgMembership.findMany).not.toHaveBeenCalled();
  });
});

describe('pendingSignupPlan — what the billing page offers', () => {
  it('offers a paid plan still waiting', () => {
    expect(pendingSignupPlan({ signupPlan: 'pro' })).toEqual({ key: 'pro', label: 'Pro' });
  });

  it('offers nothing for a free plan, an unknown one, one not offered at signup, or none', () => {
    expect(pendingSignupPlan({ signupPlan: 'starter' })).toBeNull();
    expect(pendingSignupPlan({ signupPlan: 'legacy' })).toBeNull();
    expect(pendingSignupPlan({ signupPlan: 'enterprise' })).toBeNull();
    expect(pendingSignupPlan({})).toBeNull();
  });

  it('offers it while the org still awaits its founder: the owner on the page can act', () => {
    expect(pendingSignupPlan({ signupPlan: 'pro', awaitingFounder: true })).toEqual({
      key: 'pro',
      label: 'Pro',
    });
  });

  it('offers nothing while the app’s plans failed to register', () => {
    state.plansFailed = true;
    expect(pendingSignupPlan({ signupPlan: 'pro' })).toBeNull();
  });
});

describe('a free plan — part of the org’s setup', () => {
  it('removes it, then applies it, and audits it as the founder’s', async () => {
    waiting('starter');
    takeAsStored('starter');

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(true);

    expect(mockAssignPlan).toHaveBeenCalledWith(ORG, 'starter');
    expect(mockTake.mock.invocationCallOrder[0]).toBeLessThan(
      mockAssignPlan.mock.invocationCallOrder[0]
    );
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

  it('waits while a hook this process runs is still owed, so a default it writes cannot replace it', async () => {
    hooks.keys = ['app.seed'];
    waiting('starter', { orgCreated: { owed: ['app.seed'], source: 'signup' } });

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(false);
    expect(mockTake).not.toHaveBeenCalled();
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('is not held back by a hook no process registers any more', async () => {
    hooks.keys = ['app.seed'];
    waiting('starter', { orgCreated: { owed: ['app.removed'], source: 'signup' } });
    takeAsStored('starter');

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(true);
  });

  it('waits on an owed record this version cannot read: a newer version runs its hooks', async () => {
    waiting('starter', { orgCreated: { owed: 'not-a-list', v: 9 } });

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(false);
    expect(mockTake).not.toHaveBeenCalled();
  });

  it('puts it back when the assignment fails, which changed nothing, and logs it', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(new Error('lock wait timeout'));

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(false);
    expect(mockRestore).toHaveBeenCalledWith(ORG, 'starter');
    expect(mockAudit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'billing: could not apply the plan chosen at signup',
      expect.any(Error),
      { orgId: ORG }
    );
  });

  it('tries a put-back that clashed with another settings write again', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(new Error('lock wait timeout'));
    mockRestore.mockRejectedValueOnce(conflict()).mockResolvedValueOnce(true);

    await applyFreeSignupPlan(ORG, FOUNDER);

    expect(mockRestore).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalledWith(
      'billing: could not put back the plan chosen at signup',
      expect.anything(),
      expect.anything()
    );
  });

  it('drops it when the provider manages the org’s plan: the owner already subscribed', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(
      new errors.BillingPlanError('PROVIDER_MANAGED', 'The provider manages this plan')
    );

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(false);
    expect(mockTake).toHaveBeenCalledTimes(1);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('applies nothing when another caller took it first', async () => {
    waiting('starter');
    mockTake.mockResolvedValue(null);

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(false);
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('writes no audit row when the org was already on it', async () => {
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockResolvedValue({ changed: false, previousPlanKey: 'starter' });

    await applyFreeSignupPlan(ORG, FOUNDER);

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('leaves a paid plan alone: it is the owner’s to start', async () => {
    waiting('pro');

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(false);
    expect(mockTake).not.toHaveBeenCalled();
    expect(mockStartCheckout).not.toHaveBeenCalled();
  });

  it('is applied by the route too, once the setup is done', async () => {
    waiting('starter');
    takeAsStored('starter');

    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({
      kind: 'applied',
      planKey: 'starter',
    });
  });
});

describe('a plan not offered at signup (an unpriced one assigned by hand)', () => {
  it('is never applied, however it came to be waiting', async () => {
    waiting('enterprise');

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(false);
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('is dropped by the take-up, as one no longer offered', async () => {
    waiting('enterprise');
    takeAsStored('enterprise');

    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({
      kind: 'dropped',
      planKey: 'enterprise',
    });
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('sends no verification link on to checkout', async () => {
    db.orgMembership.findMany.mockResolvedValue([
      { org: { settings: { signupPlan: 'enterprise' } } },
    ]);

    expect(await signupContinuationForUser(FOUNDER)).toBeNull();
  });
});

describe('a free plan waiting on hooks', () => {
  it('says so once, at warn, so a setup that never finishes is noticed', async () => {
    hooks.keys = ['app.seed'];
    waiting('starter', { orgCreated: { owed: ['app.seed'], source: 'signup' } });

    await applyFreeSignupPlan(ORG, FOUNDER);

    expect(logger.warn).toHaveBeenCalledWith(
      'billing: the free plan chosen at signup waits on org-created hooks still owed',
      { orgId: ORG, planKey: 'starter' }
    );
  });
});

describe('applyWaitingFreeSignupPlans — the sweep', () => {
  it('applies each waiting free plan the select finds, with no actor', async () => {
    db.$queryRaw.mockResolvedValue([{ id: ORG }]);
    waiting('starter');
    takeAsStored('starter');

    expect(await applyWaitingFreeSignupPlans()).toEqual({ orgs: 1, applied: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
  });

  it('selects by the registered free plans and the hooks this process runs', async () => {
    hooks.keys = ['app.seed'];
    db.$queryRaw.mockResolvedValue([]);

    await applyWaitingFreeSignupPlans();

    const values = db.$queryRaw.mock.calls[0].slice(1);
    // Only the free plans offered at signup: not the hand-assigned one.
    expect(values).toEqual(expect.arrayContaining([['starter'], ['app.seed']]));
    expect(values).not.toContainEqual(expect.arrayContaining(['enterprise']));
  });

  it('counts only what it applied, so a plan that keeps failing is not work', async () => {
    db.$queryRaw.mockResolvedValue([{ id: ORG }]);
    waiting('starter');
    takeAsStored('starter');
    mockAssignPlan.mockRejectedValue(new Error('lock wait timeout'));

    expect(await applyWaitingFreeSignupPlans()).toEqual({ orgs: 1, applied: 0 });
  });

  it('makes no query while billing is off or the plans failed to register', async () => {
    state.billingOn = false;
    expect(await applyWaitingFreeSignupPlans()).toEqual({ orgs: 0, applied: 0 });
    state.billingOn = true;
    state.plansFailed = true;
    expect(await applyWaitingFreeSignupPlans()).toEqual({ orgs: 0, applied: 0 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('a paid plan — the owner’s to start', () => {
  it('answers its checkout and leaves it waiting, for the billing page to offer again', async () => {
    waiting('pro');

    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({
      kind: 'checkout',
      planKey: 'pro',
      url: 'https://checkout.example/c/1',
    });
    expect(mockStartCheckout).toHaveBeenCalledWith(ORG, 'pro');
    expect(mockTake).not.toHaveBeenCalled();
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('throws a failed checkout for the route to answer, still waiting', async () => {
    waiting('pro');
    mockStartCheckout.mockRejectedValue(new Error('provider 503'));

    await expect(takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).rejects.toThrow('provider 503');
    expect(mockTake).not.toHaveBeenCalled();
  });

  it.each(['ACTIVE', 'PAST_DUE'])(
    'starts no second checkout over a %s subscription: the choice is settled and removed',
    async (status) => {
      waiting('pro');
      takeAsStored('pro');
      mockLoadSubscription.mockResolvedValue({ providerManaged: true, status });

      expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({ kind: 'none' });
      expect(mockStartCheckout).not.toHaveBeenCalled();
      expect(mockTake).toHaveBeenCalledTimes(1);
    }
  );

  it('leaves it waiting over an unpaid (incomplete) subscription, to offer again if it ends', async () => {
    waiting('pro');
    mockLoadSubscription.mockResolvedValue({ providerManaged: true, status: 'INCOMPLETE' });

    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({ kind: 'none' });
    expect(mockStartCheckout).not.toHaveBeenCalled();
    expect(mockTake).not.toHaveBeenCalled();
  });

  it('starts its checkout while the org still awaits its founder: the owner’s session can act', async () => {
    waiting('pro', { awaitingFounder: true });

    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toMatchObject({
      kind: 'checkout',
      planKey: 'pro',
    });
  });

  it('is removed when the owner chooses not to take it up', async () => {
    takeAsStored('pro');

    expect(await dismissSignupPlan(ORG)).toBe('pro');
    mockTake.mockResolvedValue(null);
    expect(await dismissSignupPlan(ORG)).toBeNull();
  });
});

describe('nothing to do', () => {
  it('answers none when nothing is waiting, or there is no such org', async () => {
    waiting(null);
    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({ kind: 'none' });
    db.org.findUnique.mockResolvedValue(null);
    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({ kind: 'none' });
    expect(mockTake).not.toHaveBeenCalled();
  });

  it('applies no free plan while the org still awaits its founder: the app’s setup has not run', async () => {
    waiting('starter', { awaitingFounder: true });

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(false);
    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({ kind: 'none' });
    expect(mockTake).not.toHaveBeenCalled();
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it('leaves it waiting while billing is off, or the app’s plans failed to register', async () => {
    waiting('pro');
    state.billingOn = false;
    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({ kind: 'none' });
    state.billingOn = true;
    state.plansFailed = true;
    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({ kind: 'none' });
    expect(mockTake).not.toHaveBeenCalled();
  });

  it('drops a key the app no longer registers, logged', async () => {
    waiting('legacy');
    takeAsStored('legacy');

    expect(await takeUpSignupPlan(ORG, { actorUserId: FOUNDER })).toEqual({
      kind: 'dropped',
      planKey: 'legacy',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no longer offered'),
      expect.objectContaining({ orgId: ORG, planKey: 'legacy' })
    );
  });

  it('tries a take that clashed with another settings write again', async () => {
    waiting('starter');
    mockTake.mockRejectedValueOnce(conflict()).mockResolvedValueOnce('starter');

    expect(await applyFreeSignupPlan(ORG, FOUNDER)).toBe(true);
    expect(mockTake).toHaveBeenCalledTimes(2);
  });
});

function conflict() {
  return new Prisma.PrismaClientKnownRequestError('write conflict', {
    code: 'P2034',
    clientVersion: 'test',
  });
}
