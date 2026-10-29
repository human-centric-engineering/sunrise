'use client';

/**
 * DeactivateProviderDialog
 *
 * Inline AlertDialog confirming a provider deactivation (soft-delete).
 * Loudly warns that agents pointing at this slug will error on their
 * next chat turn until the provider is reactivated or swapped.
 *
 * Distinct from `DeletePermanentlyDialog`, which hard-deletes after
 * confirming no agents/cost-log rows reference the slug.
 */

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
import type { SaveFailure } from '@/lib/errors/save-error';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';

export interface DeleteProviderTarget {
  id: string;
  name: string;
  slug: string;
}

export interface DeleteProviderDialogProps {
  target: DeleteProviderTarget | null;
  /** The refused deactivation, from `useSaveFailure()`; shown above the buttons. */
  failure: SaveFailure | null;
  /** Clears `failure`; called each time the dialog opens. */
  clearFailure?: () => void;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteProviderDialog({
  target,
  failure,
  clearFailure,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteProviderDialogProps) {
  // Committed while the deactivation runs; a failure from one row never shows on the next.
  const dialog = useCommittedDialog({
    open: !!target,
    pending: isDeleting,
    onClose: onCancel,
    clear: clearFailure,
  });

  return (
    <AlertDialog open={!!target} onOpenChange={dialog.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate provider</AlertDialogTitle>
          <AlertDialogDescription>
            This deactivates <strong>{target?.name}</strong> (
            <span className="font-mono text-xs">{target?.slug}</span>). Agents referencing this slug
            will error on their next chat turn until you reactivate the provider or reassign those
            agents. The row itself is preserved — reactivation just flips the status back on. To
            permanently remove the row instead, use <em>Delete permanently</em> from the dropdown.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <SaveError failure={failure} />

        <AlertDialogFooter>
          <AlertDialogCancel {...dialog.cancelProps}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // The parent flips `target` to null on success.
            {...dialog.actionProps()}
            onClick={(e) => dialog.confirm(e, onConfirm)}
            className="bg-amber-600 hover:bg-amber-700"
          >
            {isDeleting ? 'Deactivating…' : 'Deactivate'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
