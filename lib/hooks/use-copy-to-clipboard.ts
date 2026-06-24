'use client';

/**
 * useCopyToClipboard — best-effort "copy to clipboard" with a self-clearing
 * "copied!" flag.
 *
 * Writes text via `navigator.clipboard.writeText`, flips `copied` to `true`,
 * then resets it to `false` after `resetMs`. The reset timer is tracked in a
 * ref and cleared on unmount (and before re-arming on a rapid second copy), so
 * it never fires `setState` on an unmounted component — the leak this hook
 * exists to prevent (issue #301).
 *
 * Clipboard access can fail in insecure contexts or when the user denies
 * permission. `copy` swallows that failure (no timer is scheduled) and resolves
 * to `false`, so callers can treat copying as best-effort and react to the
 * boolean if they want to.
 *
 * @example
 * ```tsx
 * const { copied, copy } = useCopyToClipboard();
 * <Button onClick={() => void copy(text)}>
 *   {copied ? <Check /> : <Copy />}
 * </Button>
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseCopyToClipboardResult {
  /** `true` for `resetMs` after a successful copy, then back to `false`. */
  copied: boolean;
  /** Copy `text`; resolves `true` on success, `false` if the clipboard write failed. */
  copy: (text: string) => Promise<boolean>;
}

export function useCopyToClipboard(resetMs = 2000): UseCopyToClipboardResult {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending reset on unmount so it can't fire setState afterwards.
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        // Clear a prior reset before re-arming so a rapid second copy doesn't
        // let the first timer flip `copied` back early.
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), resetMs);
        return true;
      } catch {
        // Clipboard unavailable (insecure context / denied permission) — copying
        // is best-effort, so swallow and report failure via the return value.
        return false;
      }
    },
    [resetMs]
  );

  return { copied, copy };
}
