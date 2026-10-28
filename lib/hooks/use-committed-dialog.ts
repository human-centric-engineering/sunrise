'use client';

import { useEffect, useRef } from 'react';

interface Options {
  /** Whether the dialog is open. */
  open: boolean;
  /** Whether its save is in flight. */
  pending: boolean;
  /** What closing does: clear the target, reset the form. */
  onClose: () => void;
  /** What opening through the dialog's own trigger does. */
  onOpen?: () => void;
  /** Clears the dialog's failure; called each time the dialog opens or closes. */
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
  /** Spread on the button that saves: disabled while the save runs, or for its own reasons. */
  actionProps: (options?: ActionOptions) => { disabled: boolean };
  /**
   * The saving button's click: `onClick={(e) => dialog.confirm(e, handleDelete)}`.
   * It keeps the dialog open (`AlertDialogAction` would close it), so a
   * refusal is read inside; the caller closes it when the save succeeds. It
   * takes the action at click time, not during render, so an action that
   * reads a ref is fine.
   */
  confirm: (e: { preventDefault: () => void }, run: () => unknown) => void;
}

/**
 * Commits a dialog to its save while the save runs (§124): the action and
 * Cancel are disabled, and the close Radix asks for (Escape, an outside
 * click) is ignored. A second click can't send the request twice, and a
 * refusal can't arrive after the dialog closed and be shown nowhere. The
 * dialog's failure is cleared when it closes, however it closes, so one row's
 * failure never greets the next.
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
  // Cleared as it closes, by whatever route (Cancel, Escape, the caller), so
  // the next open renders with no failure: clearing only after an open lets
  // the old one show, be announced and take focus first. Opening clears too.
  useEffect(() => {
    clearRef.current?.();
  }, [open]);

  return {
    onOpenChange: (next: boolean) => {
      if (next) onOpen?.();
      else if (!pending) onClose();
    },
    cancelProps: { disabled: pending },
    actionProps: (options: ActionOptions = {}) => ({
      disabled: pending || options.disabled === true,
    }),
    confirm: (e: { preventDefault: () => void }, run: () => unknown) => {
      e.preventDefault();
      void run();
    },
  };
}
