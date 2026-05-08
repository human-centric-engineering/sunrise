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
          <AlertDialogTitle>Deactivate provider</AlertDialogTitle>
          <AlertDialogDescription>
            This deactivates <strong>{target?.name}</strong> (
            <span className="font-mono text-xs">{target?.slug}</span>). Agents referencing this slug
            will error on their next chat turn until you reactivate the provider or reassign those
            agents. The row itself is preserved — reactivation just flips the status back on. To
            permanently remove the row instead, use <em>Delete permanently</em> from the dropdown.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && <p className="text-destructive text-sm">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // preventDefault so the dialog doesn't auto-close while
            // the async deactivation is in flight — the parent flips
            // `target` to null on success.
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className="bg-amber-600 hover:bg-amber-700"
            disabled={isDeleting}
          >
            {isDeleting ? 'Deactivating…' : 'Deactivate'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
