'use client';

/**
 * useTypingAnimation — rAF-based typing animation hook.
 *
 * Sits between an SSE delta stream and the rendered text. Buffers incoming
 * chunks and releases them at a controlled rate via `requestAnimationFrame`,
 * producing a natural "typing" effect.
 *
 * `fullText` and `displayedLength` are stored in refs (not state) to avoid
 * re-render storms — only one `setState` fires per animation frame.
 *
 * **Architecture note.** The rAF chain is driven entirely from refs and
 * does not loop through React state to keep itself alive. `appendDelta`
 * kicks the first frame when the chain isn't running; each `tick` reads
 * the latest `fullTextRef` and schedules the next frame from inside
 * itself. An earlier version routed every delta through a
 * `setAnimationSignal((s) => s + 1)` indirection that triggered a
 * cleanup-and-reschedule cycle in a `useEffect`; under React 19 + bursty
 * SSE that pattern tripped "Maximum update depth exceeded" because each
 * delta cancelled and re-scheduled rAF without ever yielding to the
 * browser. Keeping the loop ref-driven avoids React's update accounting
 * entirely.
 *
 * When `disabled` is true the hook acts as a pass-through: `appendDelta`
 * immediately updates `displayText` with no buffering.
 *
 * @example
 * ```tsx
 * const { displayText, appendDelta, flush, reset } = useTypingAnimation({
 *   chunkSize: 3,
 * });
 *
 * // In SSE content handler:
 * appendDelta(delta);
 *
 * // On done event:
 * flush();
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseTypingAnimationOptions {
  /** Characters released per animation tick. Default: 3. */
  chunkSize?: number;
  /** Milliseconds between ticks (ignored — uses rAF). Kept for future use. Default: 16. */
  intervalMs?: number;
  /** Disable animation — pass-through mode. Default: false. */
  disabled?: boolean;
}

export interface UseTypingAnimationReturn {
  /** The text to render (animated subset of full text). */
  displayText: string;
  /** Whether animation is still catching up to the full text. */
  isAnimating: boolean;
  /** Call when a new delta arrives from SSE. */
  appendDelta: (delta: string) => void;
  /** Reveal all buffered text immediately (call on `done` event). */
  flush: () => void;
  /** Reset to empty (for conversation clear or content_reset). */
  reset: () => void;
}

export function useTypingAnimation(
  options: UseTypingAnimationOptions = {}
): UseTypingAnimationReturn {
  const { chunkSize = 3, disabled = false } = options;

  const [displayText, setDisplayText] = useState('');
  const [isAnimating, setIsAnimating] = useState(false);

  const fullTextRef = useRef('');
  const displayedLengthRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const chunkSizeRef = useRef(chunkSize);

  // Keep chunkSize ref in sync — read by `tick` on every iteration so
  // operator-driven changes (rare) propagate without restarting.
  useEffect(() => {
    chunkSizeRef.current = chunkSize;
  }, [chunkSize]);

  // Start a fresh rAF chain. The inner `step` is a function declaration
  // (hoisted within `startAnimation`'s scope), which is how we get
  // self-referencing recursion without the React-Compiler "accessed
  // before it is declared" diagnostic that fires when a `useCallback`
  // body references itself. Every closure-captured value here is a ref
  // or a stable state setter, so `useCallback([])` is correct.
  const startAnimation = useCallback((): void => {
    function step(): void {
      const full = fullTextRef.current;
      const current = displayedLengthRef.current;

      if (current >= full.length) {
        rafIdRef.current = null;
        setIsAnimating(false);
        return;
      }

      const next = Math.min(current + chunkSizeRef.current, full.length);
      displayedLengthRef.current = next;
      setDisplayText(full.slice(0, next));

      if (next < full.length) {
        // Tail-recurse via rAF. New deltas that arrive between frames
        // simply extend `fullTextRef.current`; the next iteration picks
        // them up automatically without needing to be "kicked" again.
        rafIdRef.current = requestAnimationFrame(step);
      } else {
        rafIdRef.current = null;
        setIsAnimating(false);
      }
    }
    rafIdRef.current = requestAnimationFrame(step);
  }, []);

  const appendDelta = useCallback(
    (delta: string) => {
      fullTextRef.current += delta;

      if (disabled) {
        displayedLengthRef.current = fullTextRef.current.length;
        setDisplayText(fullTextRef.current);
        return;
      }

      // Only kick the rAF chain when one isn't already running. Bursty
      // SSE deltas during an active animation just extend the buffer —
      // the in-flight step reads `fullTextRef.current` each iteration
      // and naturally catches up.
      if (rafIdRef.current === null) {
        setIsAnimating(true);
        startAnimation();
      }
    },
    [disabled, startAnimation]
  );

  const flush = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    displayedLengthRef.current = fullTextRef.current.length;
    setDisplayText(fullTextRef.current);
    setIsAnimating(false);
  }, []);

  const reset = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    fullTextRef.current = '';
    displayedLengthRef.current = 0;
    setDisplayText('');
    setIsAnimating(false);
  }, []);

  // Cancel any in-flight rAF on unmount so the tick doesn't try to
  // setState on a torn-down component.
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  return { displayText, isAnimating, appendDelta, flush, reset };
}
