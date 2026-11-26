/**
 * Unit Tests: the billing plan registry (§139 t-1093)
 *
 * The real registry, the real entitlement registry and the real shared init
 * gate; the app's plans and switches come from mocked `lib/app/billing.ts` and
 * `lib/app/entitlements.ts`. Pins: what a plan must hold, each refused shape,
 * that one bad plan rolls back every plan the init registered (and the
 * fallback with them), the fallback's rules, and when plans apply.
 *
 * @see lib/billing/plans.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/app/billing', () => ({ initAppBilling: vi.fn() }));
vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));

import { initAppBilling } from '@/lib/app/billing';
import { initAppEntitlements } from '@/lib/app/entitlements';
import {
  __resetBillingPlansForTests,
  billingPlansEnabled,
  billingPlansFailed,
  fallbackPlan,
  planOf,
  registeredPlans,
  registerPlan,
  setFallbackPlan,
  type PlanDefinition,
} from '@/lib/billing/plans';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
  registerMeter,
} from '@/lib/tenancy/entitlements';
import { logger } from '@/lib/logging';

const FREE: PlanDefinition = {
  key: 'free',
  label: 'Free',
  switches: { reports: false, leads: true },
  meterLimits: { seats: 3 },
  aiBudgetUsd: 5,
};
const PRO: PlanDefinition = {
  key: 'pro',
  label: ' Pro ',
  description: ' Reports, and room for a team. ',
  switches: { reports: true, leads: true },
  meterLimits: { seats: 25, convos: null },
  aiBudgetUsd: null,
  priceLookupKey: 'pro_monthly',
};

/** Have the app's init run `body` on the registry's first read. */
function appRegisters(body: () => void) {
  vi.mocked(initAppBilling).mockImplementation(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  __resetEntitlementRegistryForTests();
  __resetBillingPlansForTests();
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
    registerEntitlementSwitch({
      key: 'leads',
      label: 'Leads',
      description: '',
      whenNothingSet: true,
    });
    registerMeter({ key: 'convos', label: 'Conversations', period: 'month', count: () => 0 });
  });
  vi.mocked(initAppBilling).mockImplementation(() => {});
});

describe('registering plans', () => {
  it('holds each plan as registered, trimmed, in registration order, with the fallback', () => {
    appRegisters(() => {
      registerPlan(FREE);
      registerPlan(PRO);
      setFallbackPlan('free');
    });

    expect(registeredPlans().map((p) => p.key)).toEqual(['free', 'pro']);
    expect(planOf('pro')).toEqual({
      key: 'pro',
      label: 'Pro',
      description: 'Reports, and room for a team.',
      switches: { reports: true, leads: true },
      meterLimits: { seats: 25, convos: null },
      aiBudgetUsd: null,
      priceLookupKey: 'pro_monthly',
    });
    expect(planOf('free')?.aiBudgetUsd).toBe(5);
    expect(fallbackPlan()?.key).toBe('free');
    expect(billingPlansFailed()).toBe(false);
  });

  it('keeps a budget left out apart from null: one does not decide it, the other is no cap', () => {
    expect(registerPlanWithout('aiBudgetUsd').aiBudgetUsd).toBeUndefined();
    expect(registerPlanWithout('meterLimits').meterLimits).toEqual({});
  });

  it('runs the app init once, lazily, on the first read', () => {
    appRegisters(() => registerPlan(FREE));
    expect(initAppBilling).not.toHaveBeenCalled();

    registeredPlans();
    planOf('free');
    fallbackPlan();

    expect(initAppBilling).toHaveBeenCalledTimes(1);
  });

  it('replaces a plan registered twice under one key', () => {
    appRegisters(() => {
      registerPlan(FREE);
      registerPlan({ ...FREE, label: 'Starter' });
    });

    expect(registeredPlans().map((p) => p.label)).toEqual(['Starter']);
  });

  it.each<[string, Partial<PlanDefinition> | Record<string, unknown>, RegExp]>([
    ['a key that is not a key', { key: 'Pro Plan' }, /must be lower-case/],
    ['no label', { label: '  ' }, /needs a label/],
    ['no switches object', { switches: undefined }, /needs switches/],
    ['a switch that is the string "false"', { switches: { reports: 'false' } }, /true or false/],
    ['a switch nothing registers', { switches: { report: true } }, /nothing registers: report/],
    ['a meter nothing registers', { meterLimits: { convo: 3 } }, /nothing registers: convo/],
    ['a fractional limit', { meterLimits: { seats: 2.5 } }, /whole number/],
    ['a negative limit', { meterLimits: { seats: -1 } }, /whole number/],
    ['a budget out of range', { aiBudgetUsd: 2_000_000 }, /aiBudgetUsd/],
    ['a price lookup key with a space', { priceLookupKey: 'pro monthly' }, /priceLookupKey/],
  ])('refuses %s, and registers no plan at all', (_name, override, message) => {
    appRegisters(() => {
      registerPlan(FREE);
      registerPlan({ ...PRO, ...override });
    });

    expect(registeredPlans()).toEqual([]);
    expect(billingPlansFailed()).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('billing: initAppBilling'),
      expect.objectContaining({ error: expect.stringMatching(message) })
    );
  });

  it('refuses two plans on one price, since the provider names a plan by its price', () => {
    appRegisters(() => {
      registerPlan({ ...FREE, priceLookupKey: 'pro_monthly' });
      registerPlan(PRO);
    });

    expect(registeredPlans()).toEqual([]);
    expect(billingPlansFailed()).toBe(true);
  });

  it('rolls the fallback back with the plans', () => {
    appRegisters(() => {
      registerPlan(FREE);
      setFallbackPlan('free');
      throw new Error('the app failed after naming its fallback');
    });

    expect(fallbackPlan()).toBeNull();
    expect(registeredPlans()).toEqual([]);
  });

  it('refuses every plan once the app’s switches failed to register', () => {
    vi.mocked(initAppEntitlements).mockImplementation(() => {
      throw new Error('broken switches');
    });
    appRegisters(() => registerPlan(FREE));

    expect(registeredPlans()).toEqual([]);
    expect(billingPlansFailed()).toBe(true);
  });
});

describe('the fallback plan', () => {
  it('must be a plan the init has already registered', () => {
    appRegisters(() => {
      setFallbackPlan('free');
      registerPlan(FREE);
    });

    expect(registeredPlans()).toEqual([]);
    expect(billingPlansFailed()).toBe(true);
  });

  it('must have no price', () => {
    appRegisters(() => {
      registerPlan(PRO);
      setFallbackPlan('pro');
    });

    expect(billingPlansFailed()).toBe(true);
  });

  it('cannot be given a price by registering it again', () => {
    appRegisters(() => {
      registerPlan(FREE);
      setFallbackPlan('free');
      registerPlan({ ...FREE, priceLookupKey: 'free_monthly' });
    });

    expect(billingPlansFailed()).toBe(true);
    expect(fallbackPlan()).toBeNull();
  });

  it('is null when the app names none', () => {
    appRegisters(() => registerPlan(FREE));

    expect(fallbackPlan()).toBeNull();
  });
});

describe('billingPlansEnabled', () => {
  it('is on at multi with a plan registered, and needs no payment provider', () => {
    appRegisters(() => registerPlan(FREE));

    expect(billingPlansEnabled()).toBe(true);
  });

  it('is off at single, plans or not', () => {
    mockEnv.TENANCY_MODE = 'single';
    appRegisters(() => registerPlan(FREE));

    expect(billingPlansEnabled()).toBe(false);
  });

  it('is off with no plan registered, as on vanilla Sunrise', () => {
    expect(billingPlansEnabled()).toBe(false);
  });

  it('is off when the registration failed', () => {
    appRegisters(() => {
      throw new Error('boom');
    });

    expect(billingPlansEnabled()).toBe(false);
  });
});

/** Register FREE with one optional field left out, and read it back. */
function registerPlanWithout(field: keyof PlanDefinition) {
  __resetBillingPlansForTests();
  const plan: Record<string, unknown> = { ...FREE };
  delete plan[field];
  appRegisters(() => registerPlan(plan as unknown as PlanDefinition));
  const registered = planOf('free');
  if (!registered) throw new Error('not registered');
  return registered;
}
