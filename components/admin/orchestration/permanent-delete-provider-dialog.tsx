'use client';

/**
 * PermanentDeleteProviderDialog
 *
 * Strict confirmation for hard-deleting a provider row. The server
 * refuses (409) when any agent or cost-log row still references the
 * slug; this dialog surfaces that 409 verbatim so the operator knows
 * what to fix before retrying.
 *
 * Distinct from `DeleteProviderDialog`, which performs the soft-delete
 * (deactivate) flow.
 */

import { AlertTriangle } from 'lucide-react';

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

export interface PermanentDeleteTarget {
  id: string;
  name: string;
  slug: string;
}

export interface PermanentDeleteProviderDialogProps {
  target: PermanentDeleteTarget | null;
  error: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PermanentDeleteProviderDialog({
  target,
  error,
  isDeleting,
  onCancel,
  onConfirm,
}: PermanentDeleteProviderDialogProps) {
  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-destructive h-5 w-5" aria-hidden="true" />
            Delete permanently
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              This <strong>permanently deletes</strong> the provider row for{' '}
              <strong>{target?.name}</strong> (
              <span className="font-mono text-xs">{target?.slug}</span>). It cannot be undone — the
              row is gone, not deactivated.
            </span>
            <span className="block">
              The server refuses if any agent (primary or fallback list) or any cost-log row
              references the slug. If you see a conflict below, deactivate instead, or re-point the
              referencing agents first.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // preventDefault so Radix doesn't auto-close the dialog
            // when the async delete is in flight. The dialog stays
            // open until either the caller flips `target` to null
            // (success) or the user clicks Cancel.
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className="bg-destructive hover:bg-destructive/90"
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting…' : 'Delete permanently'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
