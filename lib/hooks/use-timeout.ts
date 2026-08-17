'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Schedule timeouts that are cancelled when the component unmounts.
 *
 * A bare `setTimeout` outlives the component that scheduled it. The component
 * goes away; the timer does not. In the browser the callback then runs against
 * a component that no longer exists — for the "hide the success banner after
 * 3s" pattern that is a state update React discards, so it looks harmless.
 *
 * It is not harmless in a test run. Vitest tears the environment down when a
 * file finishes, and a timer that fires afterwards throws
 * `ReferenceError: window is not defined` from inside React's scheduler —
 * *outside* any test. The run then exits non-zero with zero failing tests and
 * nothing naming the file that caused it, which is what made #597 so expensive
 * to chase. Under `test:coverage` the suite is ~3.5x slower, which widens the
 * window and makes it frequent.
 *
 * The returned `schedule` is stable, so it is safe in dependency arrays.
 * Behaviour is otherwise identical to `setTimeout`: scheduling twice leaves two
 * timers pending, and neither cancels the other.
 *
 * @example
 * const schedule = useTimeout();
 * setSaved(true);
 * schedule(() => setSaved(false), 2500);
 */
export function useTimeout(): (callback: () => void, delayMs: number) => void {
  const pending = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    // Captured rather than read through `.current` in the cleanup: the ref
    // object is stable for the component's lifetime, but reading it at cleanup
    // time is the pattern ESLint's exhaustive-deps rule warns about, and the
    // capture is correct here precisely because the identity never changes.
    const timers = pending.current;
    return () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

  return useCallback((callback: () => void, delayMs: number) => {
    const id = setTimeout(() => {
      pending.current.delete(id);
      callback();
    }, delayMs);
    pending.current.add(id);
  }, []);
}
