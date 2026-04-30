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

  // Signal state: incremented to trigger the animation effect
  const [animationSignal, setAnimationSignal] = useState(0);

  const fullTextRef = useRef('');
  const displayedLengthRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const chunkSizeRef = useRef(chunkSize);

  // Keep chunkSize ref in sync
  useEffect(() => {
    chunkSizeRef.current = chunkSize;
  }, [chunkSize]);

  // Animation loop driven by effect — avoids self-referencing useCallback
  useEffect(() => {
    if (animationSignal === 0) return;

    const tick = (): void => {
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
        rafIdRef.current = requestAnimationFrame(tick);
      } else {
        rafIdRef.current = null;
        setIsAnimating(false);
      }
    };

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [animationSignal]);

  const appendDelta = useCallback(
    (delta: string) => {
      fullTextRef.current += delta;

      if (disabled) {
        displayedLengthRef.current = fullTextRef.current.length;
        setDisplayText(fullTextRef.current);
        return;
      }

      // Signal the animation effect to start/continue
      setIsAnimating(true);
      setAnimationSignal((s) => s + 1);
    },
    [disabled]
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

  return { displayText, isAnimating, appendDelta, flush, reset };
}
