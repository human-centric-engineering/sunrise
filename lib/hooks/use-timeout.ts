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
 * Scheduling twice leaves two timers pending, and neither cancels the other.
 *
 * **One deliberate divergence from `setTimeout`:** once the component has
 * unmounted, `schedule()` is a silent no-op. That is what makes an
 * uncancellable timer impossible — almost every caller schedules from the
 * continuation of an `await`, so a component unmounted mid-request would
 * otherwise queue work into a set the cleanup has already drained. The cost is
 * that a deferred side effect which *should* outlive the component is dropped
 * without warning: `accept-invite-form.tsx` defers a `router.push` by 1500ms,
 * and if that form ever unmounts first the navigation no longer happens. Use a
 * bare `setTimeout` (and own the cleanup) where the effect must survive.
 *
 * @example
 * const schedule = useTimeout();
 * setSaved(true);
 * schedule(() => setSaved(false), 2500);
 */
export function useTimeout(): (callback: () => void, delayMs: number) => void {
  const pending = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const unmounted = useRef(false);

  useEffect(() => {
    // Reset on mount, not just at declaration: React 19 StrictMode invokes
    // effects mount → cleanup → mount, so a flag only ever set `true` would
    // leave a genuinely-mounted component refusing to schedule anything.
    unmounted.current = false;

    // Captured rather than read through `.current` in the cleanup: the ref
    // object is stable for the component's lifetime, but reading it at cleanup
    // time is the pattern ESLint's exhaustive-deps rule warns about, and the
    // capture is correct here precisely because the identity never changes.
    const timers = pending.current;
    return () => {
      unmounted.current = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

  return useCallback((callback: () => void, delayMs: number) => {
    // The cleanup above runs exactly once. Anything scheduled *after* it would
    // be added to a set nothing will ever drain again — an uncancellable timer,
    // which is the precise failure this hook exists to prevent. It is not a
    // corner case: almost every call site schedules from the continuation of an
    // `await`, so a component unmounted while its request is in flight lands
    // here. Dropping the work matches what React already does with a state
    // update on an unmounted component.
    if (unmounted.current) return;

    const id = setTimeout(() => {
      pending.current.delete(id);
      callback();
    }, delayMs);
    pending.current.add(id);
  }, []);
}
