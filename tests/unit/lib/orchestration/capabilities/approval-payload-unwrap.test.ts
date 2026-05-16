import { describe, expect, it } from 'vitest';

import { unwrapApprovalPayload } from '@/lib/orchestration/capabilities/approval-payload-unwrap';

describe('unwrapApprovalPayload', () => {
  it('lifts approvalPayload keys to top level', () => {
    const wrapped = {
      approved: true,
      actor: 'admin:user-1',
      notes: null,
      approvalPayload: {
        models: [{ model_id: 'm1' }],
        newModels: [],
        deactivateModels: [],
      },
    };
    expect(unwrapApprovalPayload(wrapped)).toEqual({
      approved: true,
      actor: 'admin:user-1',
      notes: null,
      approvalPayload: wrapped.approvalPayload,
      models: [{ model_id: 'm1' }],
      newModels: [],
      deactivateModels: [],
    });
  });

  it('is a no-op when approvalPayload is missing', () => {
    const direct = { models: [{ model_id: 'm1' }] };
    expect(unwrapApprovalPayload(direct)).toBe(direct);
  });

  it('is a no-op when approvalPayload is null', () => {
    const v = { approved: true, approvalPayload: null };
    expect(unwrapApprovalPayload(v)).toBe(v);
  });

  it('is a no-op for primitives and arrays', () => {
    expect(unwrapApprovalPayload('hello')).toBe('hello');
    expect(unwrapApprovalPayload(42)).toBe(42);
    expect(unwrapApprovalPayload(null)).toBe(null);
    const arr = [1, 2, 3];
    expect(unwrapApprovalPayload(arr)).toBe(arr);
  });

  it('overrides wrapper keys with approvalPayload keys', () => {
    // If both the wrapper and the payload define `models`, the payload
    // wins — the wrapper's `approved: true` should never spill into a
    // capability's `models` argument.
    const v = {
      models: ['from-wrapper'],
      approvalPayload: { models: ['from-payload'] },
    };
    const result = unwrapApprovalPayload(v) as { models: string[] };
    expect(result.models).toEqual(['from-payload']);
  });
});
