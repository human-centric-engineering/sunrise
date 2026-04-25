/**
 * useWizard Hook Tests
 *
 * Covers bounds, clamp behaviour, navigation helpers, and reset.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useWizard } from '@/lib/hooks/use-wizard';

describe('useWizard', () => {
  it('starts at 0 by default and reports isFirst', () => {
    const { result } = renderHook(() => useWizard({ totalSteps: 5 }));
    expect(result.current.stepIndex).toBe(0);
    // test-review:accept tobe_true — boolean state field `isFirst`; asserting initial wizard position
    expect(result.current.isFirst).toBe(true);
    expect(result.current.isLast).toBe(false);
  });

  it('next() advances up to the last step and clamps', () => {
    const { result } = renderHook(() => useWizard({ totalSteps: 3 }));
    act(() => result.current.next());
    expect(result.current.stepIndex).toBe(1);
    act(() => result.current.next());
    expect(result.current.stepIndex).toBe(2);
    // test-review:accept tobe_true — boolean state field `isLast`; asserting wizard reached final step
    expect(result.current.isLast).toBe(true);
    act(() => result.current.next());
    expect(result.current.stepIndex).toBe(2);
  });

  it('prev() decrements but never below 0', () => {
    const { result } = renderHook(() => useWizard({ totalSteps: 3, initialIndex: 2 }));
    act(() => result.current.prev());
    expect(result.current.stepIndex).toBe(1);
    act(() => result.current.prev());
    act(() => result.current.prev());
    expect(result.current.stepIndex).toBe(0);
  });

  it('goTo() clamps out-of-range indices', () => {
    const { result } = renderHook(() => useWizard({ totalSteps: 4 }));
    act(() => result.current.goTo(99));
    expect(result.current.stepIndex).toBe(3);
    act(() => result.current.goTo(-10));
    expect(result.current.stepIndex).toBe(0);
    act(() => result.current.goTo(2));
    expect(result.current.stepIndex).toBe(2);
  });

  it('reset() returns to initial index', () => {
    const { result } = renderHook(() => useWizard({ totalSteps: 4, initialIndex: 1 }));
    act(() => result.current.goTo(3));
    act(() => result.current.reset());
    expect(result.current.stepIndex).toBe(1);
  });

  it('clamps non-finite initial index', () => {
    const { result } = renderHook(() => useWizard({ totalSteps: 3, initialIndex: Number.NaN }));
    expect(result.current.stepIndex).toBe(0);
  });

  it('clamps to 0 when totalSteps is 0', () => {
    const { result } = renderHook(() => useWizard({ totalSteps: 0 }));
    expect(result.current.stepIndex).toBe(0);
    // test-review:accept tobe_true — boolean state field `isFirst`; both isFirst and isLast are true when totalSteps=0
    expect(result.current.isFirst).toBe(true);
    // test-review:accept tobe_true — boolean state field `isLast`; degenerate case where step 0 === max(0, 0-1)
    expect(result.current.isLast).toBe(true);
    // next/prev should be no-ops
    act(() => result.current.next());
    expect(result.current.stepIndex).toBe(0);
  });
});
