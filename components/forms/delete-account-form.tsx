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
import { useRouter } from 'next/navigation';
import { Loader2, AlertTriangle } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { useSettingsAnalytics } from '@/lib/analytics/events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

export function DeleteAccountForm() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { trackAccountDeleted } = useSettingsAnalytics();

  const isConfirmed = confirmation === 'DELETE';

  const handleDelete = async () => {
    if (!isConfirmed) return;

    try {
      setIsLoading(true);
      setError(null);

      await apiClient.delete('/api/v1/users/me', {
        body: { confirmation: 'DELETE' },
      });

      // Track account deletion
      void trackAccountDeleted();

      // Redirect to home page after successful deletion
      router.push('/');
      router.refresh();
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message || 'Failed to delete account');
      } else {
        setError('An unexpected error occurred');
      }
      setIsLoading(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      // Reset state when dialog closes
      setConfirmation('');
      setError(null);
    }
  };

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

          <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                Delete Account
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. This will permanently delete your account and remove
                  all of your data from our servers.
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

                {error && (
                  <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                    {error}
                  </div>
                )}
              </div>

              <AlertDialogFooter>
                <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void handleDelete()}
                  disabled={!isConfirmed || isLoading}
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
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}
