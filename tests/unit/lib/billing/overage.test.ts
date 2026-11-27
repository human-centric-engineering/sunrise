/**
 * Unit Tests: the overage rule's pure parts (§139 t-1097)
 *
 * Which limit each rule writes, where usage stands against an allowance, the
 * excess a soft cap reports, and the notice handler slot. Registering a plan's
 * metered items, with each refused shape, is plans.test.ts; the rules on a
 * real database are `npm run smoke:billing-usage`.
 *
 * @see lib/billing/overage.ts
 */

import { describe, expect, it } from 'vitest';

import {
  AI_SPEND_METER_KEY,
  allowanceState,
  excessOver,
  meteredItemLimits,
  setUsageNoticeHandler,
  usageNoticeHandlerSlot,
  type MeteredItem,
} from '@/lib/billing/overage';

function item(overrides: Partial<MeteredItem> = {}): MeteredItem {
  return {
    meterKey: 'convos',
    overage: 'warn',
    allowance: 10,
    providerMeter: null,
    warnAtPercent: 80,
    ...overrides,
  };
}

describe('meteredItemLimits', () => {
  it('writes a hard cap’s allowance as the limit, and no limit for warn and soft cap', () => {
    expect(
      meteredItemLimits({
        docs: item({ meterKey: 'docs', overage: 'hard_cap', allowance: 5, warnAtPercent: null }),
        convos: item({ meterKey: 'convos', overage: 'soft_cap', providerMeter: 'c' }),
        leads: item({ meterKey: 'leads', overage: 'warn' }),
      })
    ).toEqual({ docs: 5, convos: null, leads: null });
  });

  it('writes nothing for AI spend, which has no meter limit', () => {
    expect(
      meteredItemLimits({ [AI_SPEND_METER_KEY]: item({ meterKey: AI_SPEND_METER_KEY }) })
    ).toEqual({});
  });
});

describe('allowanceState', () => {
  it.each([
    [0, 'within'],
    [7, 'within'],
    [8, 'near'],
    [9, 'near'],
    [10, 'reached'],
    [25, 'reached'],
  ] as const)('a warn item at 80%% of 10, used %i, is %s', (used, state) => {
    expect(allowanceState(item(), used)).toBe(state);
  });

  it('a soft or hard cap is never "near": it has no threshold', () => {
    const soft = item({ overage: 'soft_cap', warnAtPercent: null });
    expect(allowanceState(soft, 9)).toBe('within');
    expect(allowanceState(soft, 10)).toBe('reached');
  });

  it('works the threshold in whole numbers, so 80% of 3 is near at 3 rather than 2.4', () => {
    // 2 * 100 = 200 < 240; 3 reaches the allowance itself.
    expect(allowanceState(item({ allowance: 3 }), 2)).toBe('within');
    expect(allowanceState(item({ allowance: 3 }), 3)).toBe('reached');
  });
});

describe('excessOver', () => {
  it('is what was used past the allowance, and never below zero', () => {
    expect(excessOver({ allowance: 10 }, 25)).toBe(15);
    expect(excessOver({ allowance: 10 }, 10)).toBe(0);
    expect(excessOver({ allowance: 10 }, 3)).toBe(0);
    // Purely usage-based: an allowance of zero bills everything.
    expect(excessOver({ allowance: 0 }, 7)).toBe(7);
  });
});

describe('setUsageNoticeHandler', () => {
  it('holds the handler the app sets, and refuses anything that is not a function', () => {
    const handler = () => {};
    setUsageNoticeHandler(handler);
    expect(usageNoticeHandlerSlot().handler).toBe(handler);
    expect(() => setUsageNoticeHandler('email' as never)).toThrow(/takes a function/);
    expect(usageNoticeHandlerSlot().handler).toBe(handler);
    usageNoticeHandlerSlot().handler = null;
  });
});
