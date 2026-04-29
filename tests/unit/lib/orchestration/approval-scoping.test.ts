/**
 * Unit Test: Approver scoping helper
 *
 * Tests the isApproverInTrace() function that checks whether a user
 * is listed as a delegated approver in an execution's trace.
 */

import { describe, it, expect } from 'vitest';
import { isApproverInTrace } from '@/lib/orchestration/approval-scoping';

const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_ID = 'cmjbv4i3x00003wsloputgwz9';

function makeTrace(
  approverUserIds?: string[],
  status: string = 'awaiting_approval'
): Array<Record<string, unknown>> {
  return [
    {
      stepId: 'step-1',
      stepType: 'human_approval',
      label: 'Review',
      status,
      output: { prompt: 'Approve?', ...(approverUserIds ? { approverUserIds } : {}) },
      tokensUsed: 0,
      costUsd: 0,
      startedAt: '2025-01-01T00:00:00Z',
      completedAt: '2025-01-01T00:00:00Z',
      durationMs: 0,
    },
  ];
}

describe('isApproverInTrace', () => {
  it('returns true when user is in approverUserIds', () => {
    expect(isApproverInTrace(makeTrace([USER_ID, OTHER_ID]), USER_ID)).toBe(true);
  });

  it('returns false when user is not in approverUserIds', () => {
    expect(isApproverInTrace(makeTrace([OTHER_ID]), USER_ID)).toBe(false);
  });

  it('returns false when approverUserIds is not set', () => {
    expect(isApproverInTrace(makeTrace(), USER_ID)).toBe(false);
  });

  it('returns false when trace has no awaiting_approval entry', () => {
    expect(isApproverInTrace(makeTrace([USER_ID], 'completed'), USER_ID)).toBe(false);
  });

  it('returns false when trace is not an array', () => {
    expect(isApproverInTrace('invalid', USER_ID)).toBe(false);
  });

  it('returns false when trace is null', () => {
    expect(isApproverInTrace(null, USER_ID)).toBe(false);
  });

  it('returns false when trace is empty array', () => {
    expect(isApproverInTrace([], USER_ID)).toBe(false);
  });

  it('returns false when output is missing', () => {
    const trace = [
      {
        stepId: 'step-1',
        stepType: 'human_approval',
        label: 'Review',
        status: 'awaiting_approval',
        output: null,
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:00:00Z',
        durationMs: 0,
      },
    ];
    expect(isApproverInTrace(trace, USER_ID)).toBe(false);
  });
});
