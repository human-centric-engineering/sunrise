'use client';

/**
 * useWizard — tiny step-index state machine for multi-step flows.
 *
 * Pure in-memory state with no persistence of its own. Pair with
 * `useLocalStorage` if you need resume-across-refreshes behaviour (as in
 * the orchestration Setup Wizard).
 *
 * @example
 * ```tsx
 * const wiz = useWizard({ totalSteps: 5 });
 * wiz.stepIndex; // 0..4
 * wiz.next();
 * wiz.isLast;    // true when stepIndex === totalSteps - 1
 * ```
 */

import { useCallback, useMemo, useState } from 'react';

export interface UseWizardOptions {
  totalSteps: number;
  initialIndex?: number;
}

export interface WizardState {
  stepIndex: number;
  totalSteps: number;
  isFirst: boolean;
  isLast: boolean;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  reset: () => void;
}

function clamp(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) return 0;
  const floored = Math.floor(index);
  if (floored < 0) return 0;
  if (floored >= total) return total - 1;
  return floored;
}

export function useWizard({ totalSteps, initialIndex = 0 }: UseWizardOptions): WizardState {
  const [stepIndex, setStepIndex] = useState(() => clamp(initialIndex, totalSteps));

  const goTo = useCallback(
    (index: number) => {
      setStepIndex(clamp(index, totalSteps));
    },
    [totalSteps]
  );

  const next = useCallback(() => {
    setStepIndex((prev) => clamp(prev + 1, totalSteps));
  }, [totalSteps]);

  const prev = useCallback(() => {
    setStepIndex((prev) => clamp(prev - 1, totalSteps));
  }, [totalSteps]);

  const reset = useCallback(() => {
    setStepIndex(clamp(initialIndex, totalSteps));
  }, [initialIndex, totalSteps]);

  return useMemo<WizardState>(
    () => ({
      stepIndex,
      totalSteps,
      isFirst: stepIndex === 0,
      isLast: stepIndex === Math.max(0, totalSteps - 1),
      next,
      prev,
      goTo,
      reset,
    }),
    [stepIndex, totalSteps, next, prev, goTo, reset]
  );
}
