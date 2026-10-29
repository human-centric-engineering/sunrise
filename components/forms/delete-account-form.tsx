'use client';

/**
 * Delete Account Form
 *
 * Form for permanently deleting user account.
 * Requires typing "DELETE" to confirm.
 *
 * Phase 3.2: User Management
 */

import { useState } from 'react';
import { z } from 'zod';
import { Loader2, AlertTriangle } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useAnalytics } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveError } from '@/components/forms/form-error';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

/**
 * A 202 from the route (t-845): the account is disabled and signed out, and
 * the erasure finishes in the background.
 */
const pendingDeletionSchema = z.object({ pending: z.literal(true) });

export function DeleteAccountForm() {
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const save = useSaveFailure({
    fallback: 'Could not delete your account. Try again in a moment.',
    fields: NO_SERVER_FIELDS,
  });
  const [isPending, setIsPending] = useState(false);
  const { reset } = useAnalytics();

  const isConfirmed = confirmation === 'DELETE';

  const handleDelete = async () => {
    if (!isConfirmed) return;

    try {
      setIsLoading(true);
      save.clear();

      const result = await apiClient.delete<unknown>(API.USERS.ME, {
        body: { confirmation: 'DELETE' },
      });

      // Reset analytics identity (event tracked server-side in DELETE /api/v1/users/me)
      void reset();

      // Still being erased: say so, and leave once the person has read it.
      if (pendingDeletionSchema.safeParse(result).success) {
        setIsPending(true);
        setIsLoading(false);
        return;
      }

      // Hard redirect to home page after successful deletion.
      // Using window.location instead of router.push() to ensure all in-memory
      // session state (better-auth nanostore, cookie cache) is fully cleared.
      window.location.href = '/';
    } catch (err) {
      // Another attempt already holds the deletion. The route has signed the
      // person out all the same, so this is the pending answer, not an error.
      if (err instanceof APIClientError && err.status === 409) {
        void reset();
        setIsPending(true);
        setIsLoading(false);
        return;
      }
      save.report(err);
      setIsLoading(false);
    }
  };

  const leave = () => {
    // A hard redirect, as after a finished deletion: the session is gone.
    window.location.href = '/';
  };

  // Committed while the request runs: its answer may be a pending deletion,
  // which needs the dialog to say so and to leave the page.
  const dialog = useCommittedDialog({
    open: isOpen,
    pending: isLoading,
    onOpen: () => setIsOpen(true),
    onClose: () => {
      // The account is already disabled: closing the dialog leaves the page.
      if (isPending) {
        leave();
        return;
      }
      setIsOpen(false);
      setConfirmation('');
    },
    clear: save.clear,
  });

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/20">
      <div className="flex items-start gap-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 text-red-600 dark:text-red-400" />
        <div className="flex-1 space-y-3">
          <div>
            <h3 className="font-medium text-red-900 dark:text-red-100">Delete Account</h3>
            <p className="text-sm text-red-700 dark:text-red-300">
              Permanently delete your account and all associated data. This action cannot be undone.
            </p>
          </div>

          <AlertDialog open={isOpen} onOpenChange={dialog.onOpenChange}>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                Delete Account
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              {isPending ? (
                <>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Deletion in progress</AlertDialogTitle>
                    <AlertDialogDescription>
                      Your account is closed and you have been signed out. We are still removing
                      your data, which usually finishes within a few minutes. You do not need to do
                      anything else.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    {/* Closing the dialog leaves the page (`onClose`). */}
                    <AlertDialogAction>Continue</AlertDialogAction>
                  </AlertDialogFooter>
                </>
              ) : (
                <>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. This will permanently delete your account and
                      remove all of your data from our servers.
                    </AlertDialogDescription>
                  </AlertDialogHeader>

                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="confirmation">
                        Type <span className="font-mono font-bold">DELETE</span> to confirm
                      </Label>
                      <Input
                        id="confirmation"
                        value={confirmation}
                        onChange={(e) => setConfirmation(e.target.value)}
                        placeholder="DELETE"
                        disabled={isLoading}
                        autoComplete="off"
                      />
                    </div>

                    <SaveError failure={save.failure} />
                  </div>

                  <AlertDialogFooter>
                    <AlertDialogCancel {...dialog.cancelProps}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      // Kept open while the request runs: it shows the answer
                      // (an error, or a pending deletion).
                      {...dialog.actionProps({ disabled: !isConfirmed })}
                      onClick={(e) => dialog.confirm(e, handleDelete)}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Deleting...
                        </>
                      ) : (
                        'Delete Account'
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </>
              )}
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}
