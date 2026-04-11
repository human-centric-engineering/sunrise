'use client';

/**
 * DeleteProviderDialog (Phase 4 Session 4.3)
 *
 * Inline AlertDialog confirming a provider soft-delete. Loudly warns
 * that agents pointing at this slug will error on their next chat
 * turn until the provider is reactivated or swapped.
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

export interface DeleteProviderTarget {
  id: string;
  name: string;
  slug: string;
}

export interface DeleteProviderDialogProps {
  target: DeleteProviderTarget | null;
  error: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteProviderDialog({
  target,
  error,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteProviderDialogProps) {
  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete provider</AlertDialogTitle>
          <AlertDialogDescription>
            This soft-deletes <strong>{target?.name}</strong> (
            <span className="font-mono text-xs">{target?.slug}</span>). Agents referencing this slug
            will error on their next chat turn until you reactivate the provider or reassign those
            agents. The row itself is preserved so reactivation just flips the status back on.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && <p className="text-destructive text-sm">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-red-600 hover:bg-red-700"
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
