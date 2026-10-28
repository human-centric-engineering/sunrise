// @vitest-environment happy-dom

/**
 * useCommittedDialog tests
 *
 * While a dialog's save runs it is committed to it (§124): no second click,
 * no closing, so a refusal is always read inside the dialog. Each opening
 * clears the last failure.
 *
 * @see lib/hooks/use-committed-dialog.ts
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SaveError } from '@/components/forms/form-error';
import { APIClientError } from '@/lib/api/client';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

function setup(initial: { open: boolean; pending: boolean }) {
  const onClose = vi.fn();
  const onOpen = vi.fn();
  const clear = vi.fn();
  const hook = renderHook(
    (props: { open: boolean; pending: boolean }) =>
      useCommittedDialog({ ...props, onClose, onOpen, clear }),
    { initialProps: initial }
  );
  return { ...hook, onClose, onOpen, clear };
}

describe('useCommittedDialog', () => {
  it('closes when asked while idle', () => {
    const { result, onClose } = setup({ open: true, pending: false });

    act(() => result.current.onOpenChange(false));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a close while the save is in flight', () => {
    const { result, onClose } = setup({ open: true, pending: true });

    act(() => result.current.onOpenChange(false));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens through the dialog’s own trigger', () => {
    const { result, onOpen, onClose } = setup({ open: false, pending: false });

    act(() => result.current.onOpenChange(true));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears the failure as the dialog opens and as it closes, and not while it stays open', () => {
    const { rerender, clear } = setup({ open: false, pending: false });
    const atMount = clear.mock.calls.length;

    rerender({ open: true, pending: false });
    expect(clear).toHaveBeenCalledTimes(atMount + 1);

    // A save running and failing while open must not be cleared under it.
    rerender({ open: true, pending: true });
    rerender({ open: true, pending: false });
    expect(clear).toHaveBeenCalledTimes(atMount + 1);

    // Closed by any route, e.g. the caller clearing its target.
    rerender({ open: false, pending: false });
    expect(clear).toHaveBeenCalledTimes(atMount + 2);
  });

  it('does not clear on every render when given a new clear each time', () => {
    const clears: Array<() => void> = [];
    const { rerender } = renderHook(
      ({ n }: { n: number }) => {
        const clear = vi.fn();
        clears[n] = clear;
        return useCommittedDialog({ open: true, pending: false, onClose: vi.fn(), clear });
      },
      { initialProps: { n: 0 } }
    );

    rerender({ n: 1 });
    rerender({ n: 2 });

    expect(clears[0]).toHaveBeenCalledTimes(1);
    expect(clears[1]).not.toHaveBeenCalled();
    expect(clears[2]).not.toHaveBeenCalled();
  });

  it('disables Cancel and the action while the save runs, and the action keeps its own reasons', () => {
    const { result, rerender } = setup({ open: true, pending: false });
    expect(result.current.cancelProps.disabled).toBe(false);
    expect(result.current.actionProps().disabled).toBe(false);
    expect(result.current.actionProps({ disabled: true }).disabled).toBe(true);

    rerender({ open: true, pending: true });

    expect(result.current.cancelProps.disabled).toBe(true);
    expect(result.current.actionProps().disabled).toBe(true);
  });

  it('runs the action without letting the click close the dialog', () => {
    const { result } = setup({ open: true, pending: false });
    const run = vi.fn();
    const preventDefault = vi.fn();

    result.current.confirm({ preventDefault }, run);

    expect(preventDefault).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/** A confirm dialog wired the way a list wires one. */
function DeleteDialog({ remove }: { remove: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialog = useCommittedDialog({
    open,
    pending,
    onClose: () => setOpen(false),
    clear: () => setFailed(false),
  });
  async function confirm() {
    setPending(true);
    try {
      await remove();
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={dialog.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete</AlertDialogTitle>
          <AlertDialogDescription>Really?</AlertDialogDescription>
        </AlertDialogHeader>
        {failed && <p role="alert">Delete failed</p>}
        <AlertDialogFooter>
          <AlertDialogCancel {...dialog.cancelProps}>Cancel</AlertDialogCancel>
          <AlertDialogAction {...dialog.actionProps()} onClick={(e) => dialog.confirm(e, confirm)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe('useCommittedDialog in a real AlertDialog', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('sends once however often Delete is pressed, and keeps a late refusal through Escape', async () => {
    let refuse: (err: Error) => void = () => undefined;
    const remove = vi.fn(() => new Promise<void>((_, reject) => (refuse = reject)));
    const user = userEvent.setup();
    render(<DeleteDialog remove={remove} />);

    const action = screen.getByRole('button', { name: 'Delete' });
    await user.click(action);
    await user.click(action);
    await user.keyboard('{Escape}');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => refuse(new Error('locked')));

    expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed');
    expect(screen.getByRole('alertdialog')).toContainElement(screen.getByRole('alert'));
  });

  it('closes on Escape once the save has settled', async () => {
    const user = userEvent.setup();
    render(<DeleteDialog remove={() => Promise.reject(new Error('locked'))} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('alert');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('opens for the next row with no trace of the last row’s failure', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const user = userEvent.setup();
    render(
      <TwoRows
        remove={() => Promise.reject(new APIClientError('Row A is locked', 'CONFLICT', 409))}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Delete A' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Row A is locked');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    scrollIntoView.mockClear();

    await user.click(screen.getByRole('button', { name: 'Delete B' }));
    const dialog = await screen.findByRole('alertdialog');

    // Never rendered, so never announced, scrolled to or focused.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent('Delete B?');
    expect(document.activeElement).not.toBe(document.body);
  });
});

/** A list with a delete dialog per row, wired with the real save-error pieces. */
function TwoRows({ remove }: { remove: (row: string) => Promise<void> }) {
  const [target, setTarget] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = useSaveFailure({ fallback: 'Could not delete.', fields: NO_SERVER_FIELDS });
  const dialog = useCommittedDialog({
    open: target !== null,
    pending,
    onClose: () => setTarget(null),
    clear: save.clear,
  });
  async function confirm() {
    if (!target) return;
    setPending(true);
    try {
      await remove(target);
      setTarget(null);
    } catch (err) {
      save.report(err);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button onClick={() => setTarget('A')}>Delete A</button>
      <button onClick={() => setTarget('B')}>Delete B</button>
      <AlertDialog open={target !== null} onOpenChange={dialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {target}?</AlertDialogTitle>
            <AlertDialogDescription>It goes for good.</AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={save.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...dialog.cancelProps}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              {...dialog.actionProps()}
              onClick={(e) => dialog.confirm(e, confirm)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
