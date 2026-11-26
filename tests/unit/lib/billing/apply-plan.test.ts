/**
 * Unit Tests: applyPlan() (§139 t-1093) — which writer it calls for what a
 * plan decides, and what it answers when the org is gone part-way.
 *
 * The writers are mocked here: what they store is pinned against an
 * in-memory org in `subscriptions.test.ts` and the real database in
 * `npm run smoke:billing-plans`.
 *
 * @see lib/billing/apply-plan.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetOrgSwitches = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/entitlements', () => ({ setOrgSwitches: mockSetOrgSwitches }));
const mockWriteOrgMeterLimits = vi.hoisted(() => vi.fn());
const mockUpdateOrgQuotas = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/org-settings', () => ({
  writeOrgMeterLimits: mockWriteOrgMeterLimits,
  updateOrgQuotas: mockUpdateOrgQuotas,
}));
const mockForgetOrgCap = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/llm/spend-caps', () => ({ forgetOrgCap: mockForgetOrgCap }));

import { applyPlan } from '@/lib/billing/apply-plan';
import type { RegisteredPlan } from '@/lib/billing/plans';

const ORG = 'cmorg000000000000000other';

function plan(overrides: Partial<RegisteredPlan> = {}): RegisteredPlan {
  return {
    key: 'pro',
    label: 'Pro',
    description: '',
    switches: { reports: true, leads: false },
    meterLimits: { seats: 25 },
    aiBudgetUsd: 100,
    priceLookupKey: null,
    ...overrides,
  };
}

const unchanged = {
  switches: {
    previous: { on: [], off: [], unreadable: false },
    previousStored: null,
    stored: { on: [], off: [], unreadable: false },
    changed: false,
  },
  limits: { previous: {}, previousStored: null, stored: {}, changed: false },
  quotas: { previous: {}, stored: {}, changed: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSetOrgSwitches.mockResolvedValue(unchanged.switches);
  mockWriteOrgMeterLimits.mockResolvedValue(unchanged.limits);
  mockUpdateOrgQuotas.mockResolvedValue(unchanged.quotas);
});

describe('applyPlan', () => {
  it('names each switch on or off, each limit, and only the budget among the caps', async () => {
    await applyPlan(ORG, plan());

    expect(mockSetOrgSwitches).toHaveBeenCalledWith(ORG, { on: ['reports'], off: ['leads'] });
    expect(mockWriteOrgMeterLimits).toHaveBeenCalledWith(ORG, { seats: 25 });
    expect(mockUpdateOrgQuotas).toHaveBeenCalledWith(ORG, { monthlyBudgetUsd: 100 });
  });

  it('skips a writer for what the plan does not decide', async () => {
    const result = await applyPlan(
      ORG,
      plan({ switches: {}, meterLimits: {}, aiBudgetUsd: undefined })
    );

    expect(result).toEqual({
      changed: false,
      switches: null,
      meterLimits: null,
      aiBudgetUsd: null,
    });
    expect(mockSetOrgSwitches).not.toHaveBeenCalled();
    expect(mockWriteOrgMeterLimits).not.toHaveBeenCalled();
    expect(mockUpdateOrgQuotas).not.toHaveBeenCalled();
  });

  it('clears the budget for a plan that decides there is none', async () => {
    mockUpdateOrgQuotas.mockResolvedValue({
      previous: { monthlyBudgetUsd: 5 },
      stored: {},
      changed: true,
    });

    const result = await applyPlan(ORG, plan({ aiBudgetUsd: null }));

    expect(mockUpdateOrgQuotas).toHaveBeenCalledWith(ORG, { monthlyBudgetUsd: null });
    expect(result?.aiBudgetUsd).toEqual({ from: 5, to: null });
    expect(mockForgetOrgCap).toHaveBeenCalledWith(ORG);
  });

  it('reports no change, and forgets no cap, when every writer wrote nothing', async () => {
    const result = await applyPlan(ORG, plan());

    expect(result).toEqual({
      changed: false,
      switches: null,
      meterLimits: null,
      aiBudgetUsd: null,
    });
    expect(mockForgetOrgCap).not.toHaveBeenCalled();
  });

  it.each([
    ['the switches', mockSetOrgSwitches, 0],
    ['the limits', mockWriteOrgMeterLimits, 1],
    ['the budget', mockUpdateOrgQuotas, 2],
  ] as const)(
    'is null when the org is gone by %s, and writes nothing after',
    async (_n, writer, at) => {
      writer.mockResolvedValue(null);

      expect(await applyPlan(ORG, plan())).toBeNull();
      const later = [mockSetOrgSwitches, mockWriteOrgMeterLimits, mockUpdateOrgQuotas].slice(
        at + 1
      );
      for (const next of later) expect(next).not.toHaveBeenCalled();
    }
  );
});
