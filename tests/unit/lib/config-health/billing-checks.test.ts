/**
 * Unit Tests: the billing config-health checks (§139 t-1094)
 *
 * Three checks, each applying only once BILLING_PROVIDER is set, so an
 * install that does not bill sees none: the provider not on (unknown, or its
 * keys missing), the variable set at single, and no fallback plan while
 * billing is on. Each reports presence only.
 *
 * @see lib/config-health/checks.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  TENANCY_MODE: 'multi',
  BILLING_PROVIDER: undefined as string | undefined,
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logging', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const state = vi.hoisted((): { on: boolean; fallback: unknown } => ({ on: false, fallback: null }));
vi.mock('@/lib/billing/config', () => ({
  billingProviderState: () => ({ on: state.on }),
  billingEnabled: () => state.on,
}));
vi.mock('@/lib/billing/plans', () => ({ fallbackPlan: () => state.fallback }));

import { CONFIG_HEALTH_CHECKS } from '@/lib/config-health/checks';

function check(key: string) {
  const found = CONFIG_HEALTH_CHECKS.find((c) => c.key === key);
  if (!found) throw new Error(`no check ${key}`);
  return {
    applicable: found.applicable ? found.applicable() : true,
    present: found.detect(),
    severity: found.severity,
  };
}

beforeEach(() => {
  mockEnv.TENANCY_MODE = 'multi';
  mockEnv.BILLING_PROVIDER = undefined;
  state.on = false;
  state.fallback = null;
});

describe('billing config-health checks', () => {
  it('none applies while BILLING_PROVIDER is unset', () => {
    for (const key of ['billing_provider', 'billing_single_tenant', 'billing_fallback_plan']) {
      expect(check(key).applicable, key).toBe(false);
    }
  });

  it('billing_provider: critical when the provider set is not on, met once it is', () => {
    mockEnv.BILLING_PROVIDER = 'stripe';
    expect(check('billing_provider')).toEqual({
      applicable: true,
      present: false,
      severity: 'critical',
    });
    state.on = true;
    expect(check('billing_provider').present).toBe(true);
  });

  it('billing_single_tenant: warns when BILLING_PROVIDER is set at single', () => {
    mockEnv.BILLING_PROVIDER = 'stripe';
    mockEnv.TENANCY_MODE = 'single';
    expect(check('billing_single_tenant')).toMatchObject({ applicable: true, present: false });
    // And the provider check leaves that case to it.
    expect(check('billing_provider').applicable).toBe(false);
    mockEnv.TENANCY_MODE = 'multi';
    expect(check('billing_single_tenant').present).toBe(true);
  });

  it('billing_fallback_plan: warns while billing is on and the app names no fallback', () => {
    mockEnv.BILLING_PROVIDER = 'stripe';
    expect(check('billing_fallback_plan').applicable).toBe(false);
    state.on = true;
    expect(check('billing_fallback_plan')).toEqual({
      applicable: true,
      present: false,
      severity: 'warning',
    });
    state.fallback = { key: 'free' };
    expect(check('billing_fallback_plan').present).toBe(true);
  });
});
