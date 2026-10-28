'use client';

import { useCallback, useEffect, useRef } from 'react';

interface Options {
  /** Whether the dialog is open. */
  open: boolean;
  /** Whether its save is in flight. */
  pending: boolean;
  /** What closing does: clear the target, reset the form. */
  onClose: () => void;
  /** What opening through the dialog's own trigger does. */
  onOpen?: () => void;
  /** Clears the dialog's failure; called each time the dialog opens. */
  clear?: () => void;
}

/** What an action button needs beyond the hook's: extra reasons to disable it. */
interface ActionOptions {
  disabled?: boolean;
}

export interface CommittedDialog {
  /** Pass to the dialog's `onOpenChange`. */
  onOpenChange: (open: boolean) => void;
  /** Spread on Cancel (and any other way out): disabled while the save runs. */
  cancelProps: { disabled: boolean };
  /**
   * Spread on the button that saves. Its click doesn't close the dialog
   * (`AlertDialogAction` would), so a refusal is read inside it; the dialog
   * closes when the save succeeds and the caller closes it.
   */
  actionProps: (
    run: () => unknown,
    options?: ActionOptions
  ) => { disabled: boolean; onClick: (e: { preventDefault: () => void }) => void };
}

/**
 * Commits a dialog to its save while the save runs (§124): the action and
 * Cancel are disabled, and the close Radix asks for (Escape, an outside
 * click) is ignored. A second click can't send the request twice, and a
 * refusal can't arrive after the dialog closed and be shown nowhere. The
 * dialog's failure is cleared each time it opens, so one row's failure never
 * greets the next.
 *
 * @see .context/ui/form-errors.md
 */
export function useCommittedDialog({
  open,
  pending,
  onClose,
  onOpen,
  clear,
}: Options): CommittedDialog {
  // Read through a ref so an inline `clear` doesn't re-run the effect, which
  // would wipe a live failure on every render while open.
  const clearRef = useRef(clear);
  useEffect(() => {
    clearRef.current = clear;
  });
  useEffect(() => {
    if (open) clearRef.current?.();
  }, [open]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (next) onOpen?.();
      else if (!pending) onClose();
    },
    [pending, onOpen, onClose]
  );

  const actionProps = useCallback(
    (run: () => unknown, options: ActionOptions = {}) => ({
      disabled: pending || options.disabled === true,
      onClick: (e: { preventDefault: () => void }) => {
        e.preventDefault();
        void run();
      },
    }),
    [pending]
  );

  return { onOpenChange, cancelProps: { disabled: pending }, actionProps };
}
